import os
import shutil
import json
import uuid
import asyncio
from dotenv import load_dotenv
from fastapi import FastAPI, Request, HTTPException, UploadFile, File, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel
from pathlib import Path
from datetime import datetime
import logging
from typing import Dict, List, Optional, BinaryIO
from services.stt_service import transcribe_audio
from services.llm_service import generate_llm_response
from services.tts_service import generate_tts
from services.fallback_service import generate_fallback_audio

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Load environment variables
load_dotenv()
murf_api_key = os.getenv("MURF_API_KEY")
assemblyai_api_key = os.getenv("ASSEMBLYAI_API_KEY")

# Initialize FastAPI app
app = FastAPI()

# Mount static files directory
app.mount("/static", StaticFiles(directory="static"), name="static")

# Initialize Jinja2 templates
templates = Jinja2Templates(directory="templates")

# Define the upload and audio folders
UPLOAD_FOLDER = Path("uploads")
AUDIO_FOLDER = Path("audio_recordings")
UPLOAD_FOLDER.mkdir(exist_ok=True)
AUDIO_FOLDER.mkdir(exist_ok=True)

# In-memory chat history storage
chat_histories: Dict[str, List[Dict[str, str]]] = {}

# Audio streaming session storage
active_audio_sessions: Dict[str, Dict] = {}

# WebSocket Connection Manager
class ConnectionManager:
    def __init__(self):
        self.active_connections: List[WebSocket] = []
        self.audio_connections: Dict[str, WebSocket] = {}  # session_id -> websocket

    async def connect(self, websocket: WebSocket, connection_type: str = "general"):
        await websocket.accept()
        self.active_connections.append(websocket)
        logger.info(f"WebSocket client connected ({connection_type}). Total connections: {len(self.active_connections)}")

    async def connect_audio_stream(self, websocket: WebSocket, session_id: str):
        await websocket.accept()
        self.active_connections.append(websocket)
        self.audio_connections[session_id] = websocket
        logger.info(f"Audio streaming client connected for session: {session_id}")

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)
        
        # Remove from audio connections if present
        session_to_remove = None
        for session_id, ws in self.audio_connections.items():
            if ws == websocket:
                session_to_remove = session_id
                break
        
        if session_to_remove:
            del self.audio_connections[session_to_remove]
            # Clean up audio session
            if session_to_remove in active_audio_sessions:
                self._cleanup_audio_session(session_to_remove)
        
        logger.info(f"WebSocket client disconnected. Total connections: {len(self.active_connections)}")

    def _cleanup_audio_session(self, session_id: str):
        """Clean up audio session resources"""
        if session_id in active_audio_sessions:
            session_data = active_audio_sessions[session_id]
            if 'file_handle' in session_data and session_data['file_handle']:
                try:
                    session_data['file_handle'].close()
                    logger.info(f"Closed audio file for session: {session_id}")
                except Exception as e:
                    logger.error(f"Error closing audio file for session {session_id}: {e}")
            
            del active_audio_sessions[session_id]
            logger.info(f"Cleaned up audio session: {session_id}")

    async def send_personal_message(self, message: str, websocket: WebSocket):
        try:
            await websocket.send_text(message)
        except Exception as e:
            logger.error(f"Error sending message to WebSocket: {e}")

    async def send_audio_response(self, session_id: str, message: dict):
        """Send response to audio streaming client"""
        if session_id in self.audio_connections:
            try:
                await self.audio_connections[session_id].send_text(json.dumps(message))
            except Exception as e:
                logger.error(f"Error sending audio response to session {session_id}: {e}")

    async def broadcast(self, message: str):
        disconnected = []
        for connection in self.active_connections:
            try:
                await connection.send_text(message)
            except Exception as e:
                logger.error(f"Error broadcasting to connection: {e}")
                disconnected.append(connection)
        
        # Remove disconnected connections
        for connection in disconnected:
            self.disconnect(connection)

manager = ConnectionManager()

# Pydantic models for request/response bodies
class TTSRequest(BaseModel):
    text: str = "The quick brown fox jumps over the lazy dog"
    voice_id: str = "en-US-natalie"

class ChatResponse(BaseModel):
    user_message: str
    ai_response: str
    audio_url: str
    status: str = "success"

class ErrorResponse(BaseModel):
    error: str
    error_type: str
    fallback_message: str
    audio_url: Optional[str] = None
    status: str = "error"

class WebSocketMessage(BaseModel):
    type: str = "echo"
    original_message: str
    timestamp: str
    server_response: str
    session_info: Optional[Dict] = None

class AudioStreamMessage(BaseModel):
    type: str
    session_id: str
    message: str
    timestamp: str
    data: Optional[Dict] = None

# Helper functions
def get_or_create_session(session_id: str) -> List[Dict[str, str]]:
    """Get existing chat history or create new session"""
    if session_id not in chat_histories:
        chat_histories[session_id] = []
        logger.info(f"Created new chat session: {session_id}")
    return chat_histories[session_id]

def add_message_to_history(session_id: str, role: str, content: str):
    """Add a message to the chat history"""
    try:
        if session_id not in chat_histories:
            chat_histories[session_id] = []
        chat_histories[session_id].append({"role": role, "content": content})
        logger.info(f"Added {role} message to session {session_id}: {content[:50]}...")
    except Exception as e:
        logger.error(f"Failed to add message to history: {e}")

def create_audio_session(session_id: str) -> str:
    """Create a new audio recording session"""
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"audio_stream_{session_id}_{timestamp}.wav"
    filepath = AUDIO_FOLDER / filename
    
    try:
        # Create the file and store session info
        file_handle = open(filepath, "wb")
        active_audio_sessions[session_id] = {
            'filename': filename,
            'filepath': filepath,
            'file_handle': file_handle,
            'start_time': datetime.now(),
            'chunk_count': 0,
            'total_bytes': 0
        }
        
        logger.info(f"Created audio session: {session_id} -> {filename}")
        return filename
    except Exception as e:
        logger.error(f"Failed to create audio session {session_id}: {e}")
        raise

# Routes
@app.get("/", response_class=HTMLResponse)
async def read_root(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})

@app.post("/agent/chat/{session_id}", response_class=JSONResponse)
async def chat_with_agent(session_id: str, audio_file: UploadFile = File(...)):
    # 1. Transcribe audio
    success, transcript_text, stt_error = transcribe_audio(audio_file, assemblyai_api_key)
    if not success:
        return JSONResponse(
            status_code=503,
            content=ErrorResponse(
                error="Transcription failed",
                error_type=stt_error,
                fallback_message=transcript_text,
                audio_url=generate_fallback_audio(transcript_text, "stt_error")
            ).dict()
        )

    # 2. Get LLM response
    chat_history = get_or_create_session(session_id)
    add_message_to_history(session_id, "user", transcript_text)

    success, ai_response, llm_error = generate_llm_response(chat_history, transcript_text)
    if not success:
        return JSONResponse(
            status_code=503,
            content=ErrorResponse(
                error="LLM generation failed",
                error_type=llm_error,
                fallback_message=ai_response,
                audio_url=generate_fallback_audio(ai_response, "llm_error")
            ).dict()
        )
    add_message_to_history(session_id, "assistant", ai_response)

    # 3. Generate TTS audio
    success, audio_url, tts_error = generate_tts(ai_response, murf_api_key)
    if not success:
        return JSONResponse(
            status_code=206, # Partial Content
            content=ErrorResponse(
                error="TTS generation failed",
                error_type=tts_error,
                fallback_message="Voice response unavailable, but here's the text answer.",
                audio_url=audio_url
            ).dict()
        )

    return ChatResponse(
        user_message=transcript_text,
        ai_response=ai_response,
        audio_url=audio_url,
        status="success"
    ).dict()

# Audio streaming WebSocket endpoint
@app.websocket("/ws/audio/{session_id}")
async def audio_streaming_websocket(websocket: WebSocket, session_id: str):
    """WebSocket endpoint for streaming audio data"""
    await manager.connect_audio_stream(websocket, session_id)
    
    try:
        # Send initial connection confirmation
        await manager.send_audio_response(session_id, {
            "type": "connection_established",
            "session_id": session_id,
            "message": "Audio streaming connection established",
            "timestamp": datetime.now().isoformat()
        })
        
        while True:
            try:
                # Try to receive text message first (for commands)
                message = await websocket.receive_text()
                data = json.loads(message)
                
                if data.get("type") == "start_recording":
                    # Start a new recording session
                    filename = create_audio_session(session_id)
                    await manager.send_audio_response(session_id, {
                        "type": "recording_started",
                        "session_id": session_id,
                        "filename": filename,
                        "message": "Recording started successfully",
                        "timestamp": datetime.now().isoformat()
                    })
                
                elif data.get("type") == "stop_recording":
                    # Stop recording and close file
                    if session_id in active_audio_sessions:
                        session_data = active_audio_sessions[session_id]
                        session_data['file_handle'].close()
                        
                        # Send completion response
                        await manager.send_audio_response(session_id, {
                            "type": "recording_stopped",
                            "session_id": session_id,
                            "filename": session_data['filename'],
                            "message": "Recording stopped successfully",
                            "duration": str(datetime.now() - session_data['start_time']),
                            "chunk_count": session_data['chunk_count'],
                            "total_bytes": session_data['total_bytes'],
                            "timestamp": datetime.now().isoformat()
                        })
                        
                        # Clean up session
                        del active_audio_sessions[session_id]
                    else:
                        await manager.send_audio_response(session_id, {
                            "type": "error",
                            "message": "No active recording session found",
                            "timestamp": datetime.now().isoformat()
                        })
                
                else:
                    # Echo other text messages
                    await manager.send_audio_response(session_id, {
                        "type": "echo",
                        "original_message": data,
                        "timestamp": datetime.now().isoformat()
                    })
                    
            except json.JSONDecodeError:
                # If not JSON, try to receive binary data (audio chunks)
                try:
                    audio_data = await websocket.receive_bytes()
                    
                    # Process audio chunk
                    if session_id in active_audio_sessions:
                        session_data = active_audio_sessions[session_id]
                        
                        # Write audio data to file
                        session_data['file_handle'].write(audio_data)
                        session_data['file_handle'].flush()  # Ensure data is written
                        
                        # Update session statistics
                        session_data['chunk_count'] += 1
                        session_data['total_bytes'] += len(audio_data)
                        
                        # Log every 50 chunks to avoid spam
                        if session_data['chunk_count'] % 50 == 0:
                            logger.info(f"Session {session_id}: Received {session_data['chunk_count']} chunks, {session_data['total_bytes']} bytes total")
                        
                        # Send periodic status updates (every 100 chunks)
                        if session_data['chunk_count'] % 100 == 0:
                            await manager.send_audio_response(session_id, {
                                "type": "recording_status",
                                "session_id": session_id,
                                "chunk_count": session_data['chunk_count'],
                                "total_bytes": session_data['total_bytes'],
                                "duration": str(datetime.now() - session_data['start_time']),
                                "timestamp": datetime.now().isoformat()
                            })
                    else:
                        await manager.send_audio_response(session_id, {
                            "type": "error",
                            "message": "No active recording session. Send 'start_recording' command first.",
                            "timestamp": datetime.now().isoformat()
                        })
                        
                except Exception as e:
                    logger.error(f"Error processing audio data: {e}")
                    await manager.send_audio_response(session_id, {
                        "type": "error",
                        "message": f"Error processing audio data: {str(e)}",
                        "timestamp": datetime.now().isoformat()
                    })
            
    except WebSocketDisconnect:
        manager.disconnect(websocket)
        logger.info(f"Audio streaming client disconnected: {session_id}")
    except Exception as e:
        logger.error(f"Error in audio streaming WebSocket: {e}")
        manager.disconnect(websocket)

# Regular WebSocket endpoint (existing functionality)
@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """WebSocket endpoint that echoes back received messages with additional server info"""
    await manager.connect(websocket, "general")
    
    try:
        while True:
            # Wait for message from client
            data = await websocket.receive_text()
            
            # Log the received message
            timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            logger.info(f"[WebSocket] [{timestamp}] Received message: {data}")
            
            # Try to parse as JSON, fall back to plain text
            try:
                parsed_data = json.loads(data)
                message_content = parsed_data.get("message", data)
                message_type = parsed_data.get("type", "text")
            except json.JSONDecodeError:
                message_content = data
                message_type = "text"
            
            # Create echo response with server information
            echo_response = WebSocketMessage(
                type="echo",
                original_message=message_content,
                timestamp=timestamp,
                server_response=f"Echo: {message_content}",
                session_info={
                    "active_connections": len(manager.active_connections),
                    "active_chat_sessions": len(chat_histories),
                    "active_audio_sessions": len(active_audio_sessions),
                    "message_type": message_type,
                    "server_status": "operational"
                }
            )
            
            # Send echo back to client
            await manager.send_personal_message(echo_response.json(), websocket)
            
    except WebSocketDisconnect:
        manager.disconnect(websocket)
        logger.info("WebSocket client disconnected normally")
    except Exception as e:
        logger.error(f"Error in WebSocket connection: {e}")
        manager.disconnect(websocket)

# Get audio recordings
@app.get("/audio/recordings")
async def list_audio_recordings():
    """List all saved audio recordings"""
    try:
        recordings = []
        for file_path in AUDIO_FOLDER.glob("*.wav"):
            stat = file_path.stat()
            recordings.append({
                "filename": file_path.name,
                "size": stat.st_size,
                "created": datetime.fromtimestamp(stat.st_ctime).isoformat(),
                "modified": datetime.fromtimestamp(stat.st_mtime).isoformat()
            })
        
        return {
            "recordings": recordings,
            "total_count": len(recordings),
            "active_sessions": len(active_audio_sessions)
        }
    except Exception as e:
        logger.error(f"Error listing recordings: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# Download audio recording
@app.get("/audio/recordings/{filename}")
async def download_audio_recording(filename: str):
    """Download a specific audio recording"""
    file_path = AUDIO_FOLDER / filename
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Recording not found")
    
    return FileResponse(
        path=file_path,
        media_type="audio/wav",
        filename=filename
    )

# Audio session status
@app.get("/audio/session/{session_id}")
async def get_audio_session_status(session_id: str):
    """Get status of an active audio session"""
    if session_id not in active_audio_sessions:
        raise HTTPException(status_code=404, detail="Audio session not found")
    
    session_data = active_audio_sessions[session_id]
    return {
        "session_id": session_id,
        "filename": session_data['filename'],
        "start_time": session_data['start_time'].isoformat(),
        "duration": str(datetime.now() - session_data['start_time']),
        "chunk_count": session_data['chunk_count'],
        "total_bytes": session_data['total_bytes'],
        "status": "active"
    }

# WebSocket broadcast endpoint (for testing)
@app.post("/ws/broadcast")
async def broadcast_message(message: dict):
    """Endpoint to broadcast a message to all connected WebSocket clients"""
    try:
        timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        broadcast_data = {
            "type": "broadcast",
            "message": message.get("message", "Server broadcast"),
            "timestamp": timestamp,
            "from": "server"
        }
        
        await manager.broadcast(json.dumps(broadcast_data))
        
        return {
            "status": "success",
            "message": "Broadcast sent",
            "recipients": len(manager.active_connections),
            "timestamp": timestamp
        }
    except Exception as e:
        logger.error(f"Broadcast failed: {e}")
        raise HTTPException(status_code=500, detail=f"Broadcast failed: {str(e)}")

# WebSocket status endpoint
@app.get("/ws/status")
async def websocket_status():
    """Get WebSocket server status"""
    return {
        "active_connections": len(manager.active_connections),
        "active_chat_sessions": len(chat_histories),
        "active_audio_sessions": len(active_audio_sessions),
        "audio_connections": len(manager.audio_connections),
        "server_time": datetime.now().isoformat(),
        "status": "operational"
    }

# Health check endpoint
@app.get("/health")
async def health_check():
    """Health check endpoint to verify server status."""
    return {"status": "ok"}
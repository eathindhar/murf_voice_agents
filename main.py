import os
import shutil
import json
from dotenv import load_dotenv
from fastapi import FastAPI, Request, HTTPException, UploadFile, File, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel
from pathlib import Path
from datetime import datetime
import logging
from typing import Dict, List, Optional
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

# Define the upload folder
UPLOAD_FOLDER = Path("uploads")
UPLOAD_FOLDER.mkdir(exist_ok=True)

# In-memory chat history storage
chat_histories: Dict[str, List[Dict[str, str]]] = {}

# WebSocket Connection Manager
class ConnectionManager:
    def __init__(self):
        self.active_connections: List[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)
        logger.info(f"WebSocket client connected. Total connections: {len(self.active_connections)}")

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)
        logger.info(f"WebSocket client disconnected. Total connections: {len(self.active_connections)}")

    async def send_personal_message(self, message: str, websocket: WebSocket):
        try:
            await websocket.send_text(message)
        except Exception as e:
            logger.error(f"Error sending message to WebSocket: {e}")

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

# WebSocket endpoint
@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """WebSocket endpoint that echoes back received messages with additional server info"""
    await manager.connect(websocket)
    
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
        "server_time": datetime.now().isoformat(),
        "status": "operational"
    }
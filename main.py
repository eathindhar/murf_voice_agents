import os
import shutil
import requests
from dotenv import load_dotenv
from fastapi import FastAPI, Request, HTTPException, UploadFile, File, Path
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel
from pathlib import Path as PathLib
from datetime import datetime
from google import genai
from google.genai import types
import assemblyai as aai
import uuid
import logging
from typing import Dict, List, Any, Optional
import json

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Load environment variables from .env file
load_dotenv()
api_key = os.getenv("API_KEY")
assemblyai_api_key = os.getenv("ASSEMBLYAI_API_KEY")

# Initialize API settings with error handling
try:
    if assemblyai_api_key:
        aai.settings.api_key = assemblyai_api_key
        logger.info("AssemblyAI API key configured successfully")
    else:
        logger.warning("AssemblyAI API key not found in environment variables")
except Exception as e:
    logger.error(f"Failed to configure AssemblyAI: {e}")

# Initialize FastAPI app
app = FastAPI()

# Mount static files directory
app.mount("/static", StaticFiles(directory="static"), name="static")

# Initialize Jinja2 templates
templates = Jinja2Templates(directory="templates")

# In-memory chat history storage
# Structure: {session_id: [{"role": "user", "content": "..."}, {"role": "assistant", "content": "..."}]}
chat_histories: Dict[str, List[Dict[str, str]]] = {}

# Error response configurations
FALLBACK_RESPONSES = {
    "stt_error": "I'm having trouble hearing you right now. Could you please try again?",
    "llm_error": "I'm having trouble processing your request at the moment. Please try again in a few moments.",
    "tts_error": "I understand your question but I'm having trouble speaking right now. Please check back soon.",
    "general_error": "I'm experiencing some technical difficulties. Please try again later.",
    "api_unavailable": "Some of my services are temporarily unavailable. I apologize for the inconvenience."
}

# Define Pydantic models
class TTSRequest(BaseModel):
    text: str = "The quick brown fox jumps over the lazy dog"
    voice_id: str = "en-US-natalie"

class LLMRequest(BaseModel):
    contents: str = "Explain how AI works in a few words"

class ErrorResponse(BaseModel):
    error: str
    error_type: str
    fallback_message: str
    audio_url: Optional[str] = None
    status: str = "error"

# Define the upload folder
UPLOAD_FOLDER = "uploads"
os.makedirs(UPLOAD_FOLDER, exist_ok=True)

def validate_api_keys():
    """Validate that required API keys are present"""
    missing_keys = []
    if not api_key:
        missing_keys.append("MURF_API_KEY")
    if not assemblyai_api_key:
        missing_keys.append("ASSEMBLYAI_API_KEY")
    
    if missing_keys:
        logger.warning(f"Missing API keys: {', '.join(missing_keys)}")
        return False, missing_keys
    return True, []

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
        
        chat_histories[session_id].append({
            "role": role,
            "content": content
        })
        logger.info(f"Added {role} message to session {session_id}: {content[:50]}...")
    except Exception as e:
        logger.error(f"Failed to add message to history: {e}")

def format_chat_history_for_llm(chat_history: List[Dict[str, str]], new_message: str) -> str:
    """Format chat history into a conversation prompt for the LLM"""
    try:
        conversation = "You are a helpful AI assistant. Please provide clear, concise, and friendly responses. Keep your responses conversational and not too lengthy since they will be converted to speech.\n\n"
        
        if chat_history:
            conversation += "Previous conversation:\n"
            for message in chat_history[-6:]:  # Keep last 6 messages for context (3 exchanges)
                if message["role"] == "user":
                    conversation += f"User: {message['content']}\n"
                else:
                    conversation += f"Assistant: {message['content']}\n"
            conversation += "\n"
        
        conversation += f"User: {new_message}\n\nAssistant:"
        return conversation
    except Exception as e:
        logger.error(f"Failed to format chat history: {e}")
        return f"User: {new_message}\n\nAssistant:"

def generate_fallback_audio(text: str, error_type: str = "general_error") -> Optional[str]:
    """Generate fallback audio response using a backup TTS service or return None"""
    try:
        # In a real implementation, you might use a different TTS service as backup
        # For now, we'll just log and return None
        logger.info(f"Fallback audio generation requested for: {text}")
        # Could implement backup TTS service here (e.g., gTTS, pyttsx3, etc.)
        return None
    except Exception as e:
        logger.error(f"Fallback audio generation failed: {e}")
        return None

def transcribe_audio_with_retry(audio_file, max_retries: int = 2) -> tuple[bool, str, str]:
    """Transcribe audio with retry logic and error handling"""
    if not assemblyai_api_key:
        logger.error("AssemblyAI API key not configured")
        return False, FALLBACK_RESPONSES["api_unavailable"], "api_unavailable"
    
    for attempt in range(max_retries + 1):
        try:
            logger.info(f"Transcription attempt {attempt + 1}")
            transcriber = aai.Transcriber()
            
            # Reset file pointer
            audio_file.seek(0)
            
            # Transcribe the audio data
            transcript = transcriber.transcribe(audio_file)
            
            # Check if transcription was successful
            if transcript.status == aai.TranscriptStatus.error:
                logger.error(f"AssemblyAI transcription error: {transcript.error}")
                if attempt < max_retries:
                    continue
                return False, FALLBACK_RESPONSES["stt_error"], "stt_error"
            
            if not transcript.text or transcript.text.strip() == "":
                logger.warning("Empty transcription result")
                return False, "No speech detected in the audio file", "empty_transcription"
            
            logger.info(f"Transcription successful: {transcript.text}")
            return True, transcript.text, "success"
            
        except Exception as e:
            logger.error(f"Transcription attempt {attempt + 1} failed: {e}")
            if attempt < max_retries:
                continue
            return False, FALLBACK_RESPONSES["stt_error"], "stt_error"
    
    return False, FALLBACK_RESPONSES["stt_error"], "stt_error"

def generate_llm_response_with_retry(prompt: str, max_retries: int = 2) -> tuple[bool, str, str]:
    """Generate LLM response with retry logic and error handling"""
    try:
        # Check if we can create Gemini client
        client = genai.Client()
    except Exception as e:
        logger.error(f"Failed to initialize Gemini client: {e}")
        return False, FALLBACK_RESPONSES["api_unavailable"], "api_unavailable"
    
    for attempt in range(max_retries + 1):
        try:
            logger.info(f"LLM generation attempt {attempt + 1}")
            
            llm_response = client.models.generate_content(
                model="gemini-2.0-flash-exp",
                contents=prompt,
                config=types.GenerateContentConfig(
                    thinking_config=types.ThinkingConfig(thinking_budget=0)
                ),
            )
            
            ai_response = llm_response.text.strip()
            
            if not ai_response:
                logger.warning("Empty LLM response")
                if attempt < max_retries:
                    continue
                return False, FALLBACK_RESPONSES["llm_error"], "llm_error"
            
            logger.info(f"LLM response generated successfully")
            return True, ai_response, "success"
            
        except Exception as e:
            logger.error(f"LLM generation attempt {attempt + 1} failed: {e}")
            if attempt < max_retries:
                continue
            return False, FALLBACK_RESPONSES["llm_error"], "llm_error"
    
    return False, FALLBACK_RESPONSES["llm_error"], "llm_error"

def generate_tts_with_retry(text: str, voice_id: str = "en-US-natalie", max_retries: int = 2) -> tuple[bool, Optional[str], str]:
    """Generate TTS with retry logic and error handling"""
    if not api_key:
        logger.error("Murf API key not configured")
        fallback_audio = generate_fallback_audio(text, "api_unavailable")
        return False, fallback_audio, "api_unavailable"
    
    for attempt in range(max_retries + 1):
        try:
            logger.info(f"TTS generation attempt {attempt + 1}")
            
            url = "https://api.murf.ai/v1/speech/generate"
            payload = {"text": text, "voice_id": voice_id}
            headers = {"content-type": "application/json", "api-key": api_key}
            
            response = requests.post(url, json=payload, headers=headers, timeout=30)
            
            if response.status_code == 200:
                audio_url = response.json().get("audioFile")
                if audio_url:
                    logger.info("TTS generation successful")
                    return True, audio_url, "success"
                else:
                    logger.error("Audio URL not found in Murf response")
                    if attempt < max_retries:
                        continue
            else:
                logger.error(f"Murf API error: {response.status_code}, {response.text}")
                if attempt < max_retries:
                    continue
            
        except requests.exceptions.Timeout:
            logger.error(f"TTS request timeout on attempt {attempt + 1}")
            if attempt < max_retries:
                continue
        except Exception as e:
            logger.error(f"TTS generation attempt {attempt + 1} failed: {e}")
            if attempt < max_retries:
                continue
    
    # Generate fallback audio if all attempts failed
    fallback_audio = generate_fallback_audio(text, "tts_error")
    return False, fallback_audio, "tts_error"

# Routes
@app.get("/", response_class=HTMLResponse)
async def read_root(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})

@app.get("/health", response_class=JSONResponse)
async def health_check():
    """Health check endpoint to verify API connectivity"""
    try:
        api_status, missing_keys = validate_api_keys()
        
        health_status = {
            "status": "healthy" if api_status else "degraded",
            "apis": {
                "murf": "available" if api_key else "unavailable",
                "assemblyai": "available" if assemblyai_api_key else "unavailable",
                "gemini": "unknown"  # Would need actual test to determine
            },
            "missing_keys": missing_keys if not api_status else [],
            "timestamp": datetime.now().isoformat()
        }
        
        # Try to test Gemini connection
        try:
            client = genai.Client()
            health_status["apis"]["gemini"] = "available"
        except Exception as e:
            health_status["apis"]["gemini"] = "unavailable"
            logger.warning(f"Gemini API test failed: {e}")
        
        return health_status
    except Exception as e:
        logger.error(f"Health check failed: {e}")
        return {
            "status": "unhealthy",
            "error": str(e),
            "timestamp": datetime.now().isoformat()
        }

@app.post("/generate-audio", response_class=JSONResponse)
async def generate_audio(request: TTSRequest):
    try:
        logger.info(f"Generating audio for text: {request.text[:50]}...")
        
        success, audio_url, error_type = generate_tts_with_retry(request.text, request.voice_id)
        
        if success:
            return {"audio_url": audio_url, "status": "success"}
        else:
            error_response = ErrorResponse(
                error="TTS generation failed",
                error_type=error_type,
                fallback_message=FALLBACK_RESPONSES.get(error_type, FALLBACK_RESPONSES["general_error"]),
                audio_url=audio_url  # May be None or fallback audio
            )
            return JSONResponse(
                status_code=503,
                content=error_response.dict()
            )

    except Exception as e:
        logger.error(f"Unexpected error in generate_audio: {e}")
        error_response = ErrorResponse(
            error=str(e),
            error_type="general_error",
            fallback_message=FALLBACK_RESPONSES["general_error"]
        )
        return JSONResponse(
            status_code=500,
            content=error_response.dict()
        )

@app.post("/upload-audio", response_class=JSONResponse)
async def upload_audio(audio_file: UploadFile = File(...)):
    try:
        timestamp = datetime.now().strftime("%Y%m%d%H%M%S")
        logger.info(f"Received audio file: {audio_file.filename}")
        
        file_extension = PathLib(audio_file.filename).suffix
        file_name = f"recorded_audio_{timestamp}{file_extension}"
        file_location = PathLib(UPLOAD_FOLDER) / file_name
        
        # Save the uploaded audio file
        with open(file_location, "wb") as f:
            shutil.copyfileobj(audio_file.file, f)
            
        file_size = os.path.getsize(file_location)
        
        logger.info(f"Audio file saved successfully: {file_name} ({file_size} bytes)")
        
        return {
            "file_name": audio_file.filename,
            "content_type": audio_file.content_type,
            "file_size": file_size,
            "status": "success"
        }
        
    except Exception as e:
        logger.error(f"Error uploading audio: {e}")
        raise HTTPException(status_code=500, detail=f"Upload failed: {str(e)}")

@app.post("/transcribe/file", response_class=JSONResponse)
async def transcribe_audio(audio_file: UploadFile = File(...)):
    try:
        logger.info(f"Received audio file for transcription: {audio_file.filename}")
        
        success, result, error_type = transcribe_audio_with_retry(audio_file.file)
        
        if success:
            return {
                "transcription": result,
                "status": "success",
            }
        else:
            error_response = ErrorResponse(
                error="Transcription failed",
                error_type=error_type,
                fallback_message=result
            )
            return JSONResponse(
                status_code=503 if error_type == "api_unavailable" else 400,
                content=error_response.dict()
            )

    except Exception as e:
        logger.error(f"Unexpected error in transcribe_audio: {e}")
        error_response = ErrorResponse(
            error=str(e),
            error_type="general_error",
            fallback_message=FALLBACK_RESPONSES["general_error"]
        )
        return JSONResponse(
            status_code=500,
            content=error_response.dict()
        )

@app.post("/agent/chat/{session_id}", response_class=JSONResponse)
async def chat_with_history(session_id: str, audio_file: UploadFile = File(...)):
    """
    Enhanced chat endpoint with comprehensive error handling and fallbacks
    """
    try:
        logger.info(f"Received chat request for session: {session_id}")
        
        # Step 1: Transcribe the audio with retry logic
        success, transcription_result, transcription_error = transcribe_audio_with_retry(audio_file.file)
        
        if not success:
            # Return error response with fallback message
            error_response = ErrorResponse(
                error="Speech transcription failed",
                error_type=transcription_error,
                fallback_message=transcription_result
            )
            
            # Generate fallback audio if possible
            tts_success, fallback_audio, _ = generate_tts_with_retry(transcription_result)
            if tts_success:
                error_response.audio_url = fallback_audio
            
            return JSONResponse(
                status_code=503,
                content=error_response.dict()
            )
        
        user_message = transcription_result
        logger.info(f"User said: {user_message}")
        
        # Step 2: Get chat history for this session
        try:
            chat_history = get_or_create_session(session_id)
            conversation_prompt = format_chat_history_for_llm(chat_history, user_message)
        except Exception as e:
            logger.error(f"Failed to retrieve chat history: {e}")
            # Continue with just the current message
            conversation_prompt = f"You are a helpful AI assistant. User: {user_message}\n\nAssistant:"
        
        # Step 3: Generate LLM response with retry logic
        llm_success, ai_response, llm_error = generate_llm_response_with_retry(conversation_prompt)
        
        if not llm_success:
            # Store the user message even if LLM failed
            add_message_to_history(session_id, "user", user_message)
            
            error_response = ErrorResponse(
                error="AI response generation failed",
                error_type=llm_error,
                fallback_message=ai_response
            )
            
            # Generate TTS for fallback message
            tts_success, audio_url, _ = generate_tts_with_retry(ai_response)
            if tts_success:
                error_response.audio_url = audio_url
            
            return JSONResponse(
                status_code=503,
                content=error_response.dict()
            )
        
        # Step 4: Store both messages in chat history
        add_message_to_history(session_id, "user", user_message)
        add_message_to_history(session_id, "assistant", ai_response)
        
        # Step 5: Generate TTS with retry logic
        tts_success, audio_url, tts_error = generate_tts_with_retry(ai_response)
        
        if not tts_success:
            # We have a successful conversation but TTS failed
            # Return the text response with error information
            response_data = {
                "user_message": user_message,
                "ai_response": ai_response,
                "session_id": session_id,
                "message_count": len(chat_histories[session_id]),
                "status": "partial_success",
                "tts_error": True,
                "tts_error_message": FALLBACK_RESPONSES["tts_error"],
                "audio_url": audio_url  # May be fallback audio or None
            }
            
            return JSONResponse(
                status_code=206,  # Partial Content
                content=response_data
            )
        
        # Step 6: Full success
        return {
            "audio_url": audio_url,
            "user_message": user_message,
            "ai_response": ai_response,
            "session_id": session_id,
            "message_count": len(chat_histories[session_id]),
            "status": "success",
        }

    except Exception as e:
        logger.error(f"Unexpected error in chat session {session_id}: {e}")
        
        # Try to generate fallback response
        fallback_message = FALLBACK_RESPONSES["general_error"]
        tts_success, fallback_audio, _ = generate_tts_with_retry(fallback_message)
        
        error_response = ErrorResponse(
            error=str(e),
            error_type="general_error",
            fallback_message=fallback_message,
            audio_url=fallback_audio if tts_success else None
        )
        
        return JSONResponse(
            status_code=500,
            content=error_response.dict()
        )

# Additional endpoints remain the same but with added error handling
@app.get("/agent/history/{session_id}", response_class=JSONResponse)
async def get_chat_history(session_id: str):
    try:
        if session_id not in chat_histories:
            return {
                "session_id": session_id,
                "messages": [],
                "message_count": 0,
                "status": "new_session"
            }
        
        return {
            "session_id": session_id,
            "messages": chat_histories[session_id],
            "message_count": len(chat_histories[session_id]),
            "status": "success"
        }
    except Exception as e:
        logger.error(f"Error retrieving chat history: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to retrieve chat history: {str(e)}")

@app.delete("/agent/history/{session_id}", response_class=JSONResponse)
async def clear_chat_history(session_id: str):
    try:
        if session_id in chat_histories:
            del chat_histories[session_id]
            logger.info(f"Cleared chat history for session: {session_id}")
        
        return {
            "session_id": session_id,
            "status": "cleared"
        }
    except Exception as e:
        logger.error(f"Error clearing chat history: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to clear chat history: {str(e)}")

@app.get("/agent/sessions", response_class=JSONResponse)
async def list_active_sessions():
    try:
        sessions = []
        for session_id, history in chat_histories.items():
            sessions.append({
                "session_id": session_id,
                "message_count": len(history),
                "last_message": history[-1]["content"][:50] + "..." if history else ""
            })
        
        return {
            "active_sessions": sessions,
            "total_sessions": len(sessions)
        }
    except Exception as e:
        logger.error(f"Error listing sessions: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to list sessions: {str(e)}")

# Legacy endpoint with enhanced error handling
@app.post("/llm/query", response_class=JSONResponse)
async def llm_query_audio(audio_file: UploadFile = File(...)):
    try:
        logger.info(f"Received audio file for LLM query: {audio_file.filename}")

        # Step 1: Transcribe with retry
        success, transcription_result, transcription_error = transcribe_audio_with_retry(audio_file.file)
        
        if not success:
            error_response = ErrorResponse(
                error="Transcription failed",
                error_type=transcription_error,
                fallback_message=transcription_result
            )
            return JSONResponse(status_code=503, content=error_response.dict())

        user_message = transcription_result
        
        # Step 2: Generate LLM response
        conversation_prompt = f"""You are a helpful AI assistant. Please provide a clear, concise, and friendly response to the user's question or statement. Keep your response conversational and not too lengthy since it will be converted to speech.

User said: "{user_message}"

Your response:"""

        llm_success, ai_response, llm_error = generate_llm_response_with_retry(conversation_prompt)
        
        if not llm_success:
            error_response = ErrorResponse(
                error="LLM generation failed",
                error_type=llm_error,
                fallback_message=ai_response
            )
            return JSONResponse(status_code=503, content=error_response.dict())

        # Step 3: Generate TTS
        tts_success, audio_url, tts_error = generate_tts_with_retry(ai_response)
        
        if tts_success:
            return {
                "audio_url": audio_url,
                "user_message": user_message,
                "ai_response": ai_response,
                "status": "success",
            }
        else:
            return {
                "user_message": user_message,
                "ai_response": ai_response,
                "status": "partial_success",
                "tts_error": True,
                "tts_error_message": FALLBACK_RESPONSES["tts_error"],
                "audio_url": audio_url  # May be fallback
            }

    except Exception as e:
        logger.error(f"Unexpected error in LLM query: {e}")
        error_response = ErrorResponse(
            error=str(e),
            error_type="general_error",
            fallback_message=FALLBACK_RESPONSES["general_error"]
        )
        return JSONResponse(status_code=500, content=error_response.dict())

@app.post("/llm/query-text", response_class=JSONResponse)
async def llm_request_text(request: LLMRequest):
    try:
        success, ai_response, error_type = generate_llm_response_with_retry(request.contents)
        
        if success:
            return {
                "response": ai_response,
                "status": "success",
            }
        else:
            error_response = ErrorResponse(
                error="LLM generation failed",
                error_type=error_type,
                fallback_message=ai_response
            )
            return JSONResponse(status_code=503, content=error_response.dict())
            
    except Exception as e:
        logger.error(f"Unexpected error in text LLM query: {e}")
        error_response = ErrorResponse(
            error=str(e),
            error_type="general_error",
            fallback_message=FALLBACK_RESPONSES["general_error"]
        )
        return JSONResponse(status_code=500, content=error_response.dict())

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
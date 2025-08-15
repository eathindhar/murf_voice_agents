import os
import shutil
from dotenv import load_dotenv
from fastapi import FastAPI, Request, HTTPException, UploadFile, File
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
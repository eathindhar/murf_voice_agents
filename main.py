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
from typing import Dict, List, Any

# Load environment variables from .env file
load_dotenv()
api_key = os.getenv("API_KEY")
assemblyai_api_key = os.getenv("ASSEMBLYAI_API_KEY")
aai.settings.api_key = assemblyai_api_key

# Initialize FastAPI app
app = FastAPI()

# Mount static files directory
app.mount("/static", StaticFiles(directory="static"), name="static")

# Initialize Jinja2 templates
templates = Jinja2Templates(directory="templates")

# In-memory chat history storage
# Structure: {session_id: [{"role": "user", "content": "..."}, {"role": "assistant", "content": "..."}]}
chat_histories: Dict[str, List[Dict[str, str]]] = {}

# Define a Pydantic model for request body
class TTSRequest(BaseModel):
    text: str = "The quick brown fox jumps over the lazy dog"
    voice_id: str = "en-US-natalie"  # Default voice ID, can be changed as needed


class LLMRequest(BaseModel):
    contents: str = "Explain how AI works in a few words"


# Define the upload folder
UPLOAD_FOLDER = "uploads"
os.makedirs(UPLOAD_FOLDER, exist_ok=True)


def get_or_create_session(session_id: str) -> List[Dict[str, str]]:
    """Get existing chat history or create new session"""
    if session_id not in chat_histories:
        chat_histories[session_id] = []
        print(f"Created new chat session: {session_id}")
    return chat_histories[session_id]


def add_message_to_history(session_id: str, role: str, content: str):
    """Add a message to the chat history"""
    if session_id not in chat_histories:
        chat_histories[session_id] = []
    
    chat_histories[session_id].append({
        "role": role,
        "content": content
    })
    print(f"Added {role} message to session {session_id}: {content[:50]}...")


def format_chat_history_for_llm(chat_history: List[Dict[str, str]], new_message: str) -> str:
    """Format chat history into a conversation prompt for the LLM"""
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


# Define routes
@app.get("/", response_class=HTMLResponse)
async def read_root(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})


@app.post("/generate-audio", response_class=JSONResponse)
async def generate_audio(request: TTSRequest):
    try:
        url = "https://api.murf.ai/v1/speech/generate"
        payload = {"text": request.text, "voice_id": request.voice_id}

        header = {"content-type": "application/json", "api-key": api_key}

        response = requests.post(url, json=payload, headers=header)
        # print("Murf API Response: ", response.status_code, response.json())

        if response.status_code == 200:
            audio_url = response.json().get("audioFile")
            if audio_url:
                return {"audio_url": audio_url}
            else:
                raise HTTPException(
                    status_code=500, detail="Audio URL not found in response."
                )

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/upload-audio", response_class=JSONResponse)
async def upload_audio(audio_file: UploadFile = File(...)):
    timestamp = datetime.now().strftime("%Y%m%d%H%M%S")
    print("Received audio file:", audio_file.filename)
    file_extention = PathLib(audio_file.filename).suffix
    print("File extension:", file_extention)
    file_name = f"recorded_audio_{timestamp}{file_extention}"
    print("Generated file name:", file_name)
    file_location = PathLib(UPLOAD_FOLDER) / file_name
    print("Saving audio file to:", file_location)

    try:
        # Save the uploaded audio file to a temporary location
        with open(file_location, "wb") as f:
            shutil.copyfileobj(audio_file.file, f)
        return {
            "file_name": audio_file.filename,
            "content_type": audio_file.content_type,
            "file_size": os.path.getsize(file_location),
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/transcribe/file", response_class=JSONResponse)
async def transcribe_audio(audio_file: UploadFile = File(...)):
    try:
        print(f"Received audio file for transcription: {audio_file.filename}")

        # Create transcriber instance
        transcriber = aai.Transcriber()

        # Read the audio file content
        await audio_file.seek(0)

        # Transcribe the audio data directly without saving to disk
        transcript = transcriber.transcribe(audio_file.file)

        # Check if transcription was successful
        if transcript.status == aai.TranscriptStatus.error:
            raise HTTPException(
                status_code=500, detail=f"Transcription failed: {transcript.error}"
            )

        return {
            "transcription": transcript.text,
            "status": "success",
            "confidence": getattr(transcript, "confidence", None),
        }

    except Exception as e:
        print(f"Error during transcription: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Transcription error: {str(e)}")


@app.post("/tts/echo", response_class=JSONResponse)
async def tts_echo(audio_file: UploadFile = File(...)):
    """
    New endpoint that:
    1. Receives audio file
    2. Transcribes it using AssemblyAI
    3. Sends transcription to Murf API for TTS
    4. Returns the generated audio URL
    """
    try:
        print(f"Received audio file for TTS echo: {audio_file.filename}")

        # Step 1: Transcribe the audio
        transcriber = aai.Transcriber()
        await audio_file.seek(0)

        print("Transcribing audio...")
        transcript = transcriber.transcribe(audio_file.file)

        # Check if transcription was successful
        if transcript.status == aai.TranscriptStatus.error:
            raise HTTPException(
                status_code=500, detail=f"Transcription failed: {transcript.error}"
            )

        transcribed_text = transcript.text
        print(f"Transcription successful: {transcribed_text}")

        # Check if transcription is empty
        if not transcribed_text or transcribed_text.strip() == "":
            raise HTTPException(
                status_code=400, detail="No speech detected in the audio file"
            )

        # Step 2: Send transcription to Murf API for TTS
        print("Generating audio with Murf...")
        murf_url = "https://api.murf.ai/v1/speech/generate"
        murf_payload = {
            "text": transcribed_text,
            "voice_id": "en-US-natalie",  # Using Natalie as default voice
        }

        murf_headers = {"content-type": "application/json", "api-key": api_key}

        murf_response = requests.post(murf_url, json=murf_payload, headers=murf_headers)

        if murf_response.status_code == 200:
            audio_url = murf_response.json().get("audioFile")
            if audio_url:
                return {
                    "audio_url": audio_url,
                    "transcription": transcribed_text,
                    "status": "success",
                }
            else:
                raise HTTPException(
                    status_code=500, detail="Audio URL not found in Murf response"
                )
        else:
            print(f"Murf API error: {murf_response.status_code}, {murf_response.text}")
            raise HTTPException(
                status_code=500, detail=f"Murf API error: {murf_response.status_code}"
            )

    except HTTPException:
        # Re-raise HTTP exceptions as-is
        raise
    except Exception as e:
        print(f"Error in TTS echo: {str(e)}")
        raise HTTPException(status_code=500, detail=f"TTS echo error: {str(e)}")


@app.post("/agent/chat/{session_id}", response_class=JSONResponse)
async def chat_with_history(session_id: str, audio_file: UploadFile = File(...)):
    """
    Chat endpoint with session-based history:
    1. Receives audio file and session_id
    2. Transcribes audio using AssemblyAI
    3. Retrieves chat history for the session
    4. Sends conversation context to Gemini LLM
    5. Stores both user message and AI response in chat history
    6. Converts AI response to speech using Murf API
    7. Returns audio URL and conversation data
    """
    try:
        print(f"Received chat request for session: {session_id}")

        # Step 1: Transcribe the audio
        transcriber = aai.Transcriber()
        await audio_file.seek(0)

        print("Transcribing audio...")
        transcript = transcriber.transcribe(audio_file.file)

        # Check if transcription was successful
        if transcript.status == aai.TranscriptStatus.error:
            raise HTTPException(
                status_code=500, detail=f"Transcription failed: {transcript.error}"
            )

        user_message = transcript.text
        print(f"User said: {user_message}")

        # Check if transcription is empty
        if not user_message or user_message.strip() == "":
            raise HTTPException(
                status_code=400, detail="No speech detected in the audio file"
            )

        # Step 2: Get chat history for this session
        chat_history = get_or_create_session(session_id)
        
        # Step 3: Format conversation for LLM
        conversation_prompt = format_chat_history_for_llm(chat_history, user_message)
        
        print("Generating LLM response with conversation context...")
        client = genai.Client()
        
        llm_response = client.models.generate_content(
            model="gemini-2.0-flash-exp",
            contents=conversation_prompt,
            config=types.GenerateContentConfig(
                thinking_config=types.ThinkingConfig(thinking_budget=0)  # Disables thinking
            ),
        )
        
        ai_response = llm_response.text.strip()
        print(f"AI response: {ai_response}")

        if not ai_response:
            raise HTTPException(status_code=500, detail="Empty response from LLM")

        # Step 4: Store both messages in chat history
        add_message_to_history(session_id, "user", user_message)
        add_message_to_history(session_id, "assistant", ai_response)

        # Step 5: Convert AI response to speech
        print("Generating audio response with Murf...")
        murf_url = "https://api.murf.ai/v1/speech/generate"
        murf_payload = {
            "text": ai_response,
            "voice_id": "en-US-natalie",  # Using Natalie as default voice
        }

        murf_headers = {"content-type": "application/json", "api-key": api_key}

        murf_response = requests.post(murf_url, json=murf_payload, headers=murf_headers)

        if murf_response.status_code == 200:
            audio_url = murf_response.json().get("audioFile")
            if audio_url:
                return {
                    "audio_url": audio_url,
                    "user_message": user_message,
                    "ai_response": ai_response,
                    "session_id": session_id,
                    "message_count": len(chat_histories[session_id]),
                    "status": "success",
                }
            else:
                raise HTTPException(
                    status_code=500, detail="Audio URL not found in Murf response"
                )
        else:
            print(f"Murf API error: {murf_response.status_code}, {murf_response.text}")
            raise HTTPException(
                status_code=500, detail=f"Murf API error: {murf_response.status_code}"
            )

    except HTTPException:
        # Re-raise HTTP exceptions as-is
        raise
    except Exception as e:
        print(f"Error in chat session {session_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Chat error: {str(e)}")


@app.get("/agent/history/{session_id}", response_class=JSONResponse)
async def get_chat_history(session_id: str):
    """Get chat history for a specific session"""
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


@app.delete("/agent/history/{session_id}", response_class=JSONResponse)
async def clear_chat_history(session_id: str):
    """Clear chat history for a specific session"""
    if session_id in chat_histories:
        del chat_histories[session_id]
        print(f"Cleared chat history for session: {session_id}")
    
    return {
        "session_id": session_id,
        "status": "cleared"
    }


@app.get("/agent/sessions", response_class=JSONResponse)
async def list_active_sessions():
    """List all active chat sessions"""
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


# Legacy endpoints (keeping for backward compatibility)
@app.post("/llm/query", response_class=JSONResponse)
async def llm_query_audio(audio_file: UploadFile = File(...)):
    """
    Updated LLM endpoint that:
    1. Receives audio file
    2. Transcribes it using AssemblyAI
    3. Sends transcription to Gemini LLM for intelligent response
    4. Sends LLM response to Murf API for TTS
    5. Returns the generated audio URL and conversation data
    """
    try:
        print(f"Received audio file for LLM query: {audio_file.filename}")

        # Step 1: Transcribe the audio
        transcriber = aai.Transcriber()
        await audio_file.seek(0)

        print("Transcribing audio...")
        transcript = transcriber.transcribe(audio_file.file)

        # Check if transcription was successful
        if transcript.status == aai.TranscriptStatus.error:
            raise HTTPException(
                status_code=500, detail=f"Transcription failed: {transcript.error}"
            )

        user_message = transcript.text
        print(f"User said: {user_message}")

        # Check if transcription is empty
        if not user_message or user_message.strip() == "":
            raise HTTPException(
                status_code=400, detail="No speech detected in the audio file"
            )

        # Step 2: Send transcription to Gemini LLM
        print("Generating LLM response...")
        client = genai.Client()
        
        # Create a conversational prompt
        conversation_prompt = f"""You are a helpful AI assistant. Please provide a clear, concise, and friendly response to the user's question or statement. Keep your response conversational and not too lengthy since it will be converted to speech.

User said: "{user_message}"

Your response:"""

        llm_response = client.models.generate_content(
            model="gemini-2.0-flash-exp",
            contents=conversation_prompt,
            config=types.GenerateContentConfig(
                thinking_config=types.ThinkingConfig(thinking_budget=0)  # Disables thinking
            ),
        )
        
        ai_response = llm_response.text.strip()
        print(f"AI response: {ai_response}")

        if not ai_response:
            raise HTTPException(status_code=500, detail="Empty response from LLM")

        # Step 3: Send LLM response to Murf API for TTS
        print("Generating audio response with Murf...")
        murf_url = "https://api.murf.ai/v1/speech/generate"
        murf_payload = {
            "text": ai_response,
            "voice_id": "en-US-natalie",  # Using Natalie as default voice
        }

        murf_headers = {"content-type": "application/json", "api-key": api_key}

        murf_response = requests.post(murf_url, json=murf_payload, headers=murf_headers)

        if murf_response.status_code == 200:
            audio_url = murf_response.json().get("audioFile")
            if audio_url:
                return {
                    "audio_url": audio_url,
                    "user_message": user_message,
                    "ai_response": ai_response,
                    "status": "success",
                }
            else:
                raise HTTPException(
                    status_code=500, detail="Audio URL not found in Murf response"
                )
        else:
            print(f"Murf API error: {murf_response.status_code}, {murf_response.text}")
            raise HTTPException(
                status_code=500, detail=f"Murf API error: {murf_response.status_code}"
            )

    except HTTPException:
        # Re-raise HTTP exceptions as-is
        raise
    except Exception as e:
        print(f"Error in LLM query: {str(e)}")
        raise HTTPException(status_code=500, detail=f"LLM query error: {str(e)}")


# Keep the original text-based LLM endpoint for backward compatibility
@app.post("/llm/query-text", response_class=JSONResponse)
async def llm_request_text(request: LLMRequest):
    client = genai.Client() 
    response = client.models.generate_content(
        model="gemini-2.0-flash-exp",
        contents=request.contents,
        config=types.GenerateContentConfig(
            thinking_config=types.ThinkingConfig(thinking_budget=0)  # Disables thinking
        ),
    )
    print(response.text)
    return {
        "response": response.text,
        "status": "success",
    }
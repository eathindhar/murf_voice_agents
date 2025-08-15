import logging
import assemblyai as aai
from fastapi import UploadFile
from typing import Tuple

logger = logging.getLogger(__name__)

# Fallback responses for various errors
FALLBACK_RESPONSES = {
    "stt_error": "I'm having trouble hearing you right now. Could you please try again?",
    "api_unavailable": "Some of my services are temporarily unavailable. I apologize for the inconvenience."
}

def transcribe_audio(audio_file: UploadFile, api_key: str, max_retries: int = 2) -> Tuple[bool, str, str]:
    """Transcribe audio with retry logic and error handling"""
    if not api_key:
        logger.error("AssemblyAI API key not configured")
        return False, FALLBACK_RESPONSES["api_unavailable"], "api_unavailable"
    
    aai.settings.api_key = api_key
    
    for attempt in range(max_retries + 1):
        try:
            logger.info(f"Transcription attempt {attempt + 1}")
            transcriber = aai.Transcriber()
            
            # Reset file pointer
            audio_file.file.seek(0)
            
            transcript = transcriber.transcribe(audio_file.file)
            
            if transcript.status == aai.TranscriptStatus.error:
                logger.error(f"AssemblyAI transcription error: {transcript.error}")
                if attempt < max_retries:
                    continue
                return False, FALLBACK_RESPONSES["stt_error"], "stt_error"
            
            if not transcript.text or transcript.text.strip() == "":
                logger.warning("Empty transcription result")
                return False, "No speech detected in the audio file", "empty_transcription"
            
            logger.info(f"Transcription successful: {transcript.text[:50]}...")
            return True, transcript.text, "success"
            
        except Exception as e:
            logger.error(f"Transcription attempt {attempt + 1} failed: {e}")
            if attempt < max_retries:
                continue
            return False, FALLBACK_RESPONSES["stt_error"], "stt_error"
    
    return False, FALLBACK_RESPONSES["stt_error"], "stt_error"
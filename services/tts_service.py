import requests
import logging
from typing import Optional, Tuple

logger = logging.getLogger(__name__)

# Fallback responses for various errors
FALLBACK_RESPONSES = {
    "tts_error": "I understand your question but I'm having trouble speaking right now. Please check back soon.",
    "api_unavailable": "Some of my services are temporarily unavailable. I apologize for the inconvenience."
}

def generate_tts(text: str, api_key: str, voice_id: str = "en-US-natalie", max_retries: int = 2) -> Tuple[bool, Optional[str], str]:
    """Generate TTS with retry logic and error handling"""
    if not api_key:
        logger.error("Murf API key not configured")
        return False, None, "api_unavailable"
    
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
    
    return False, None, "tts_error"
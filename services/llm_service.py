import logging
from typing import Dict, List, Tuple
from google import genai
from google.genai import types

logger = logging.getLogger(__name__)

# Fallback responses for various errors
FALLBACK_RESPONSES = {
    "llm_error": "I'm having trouble processing your request at the moment. Please try again in a few moments.",
    "api_unavailable": "Some of my services are temporarily unavailable. I apologize for the inconvenience."
}

def format_chat_history_for_llm(chat_history: List[Dict[str, str]], new_message: str) -> str:
    """Format chat history into a conversation prompt for the LLM"""
    try:
        conversation = "You are a helpful AI assistant. Please provide clear, concise, and friendly responses. Keep your responses conversational and not too lengthy since they will be converted to speech.\n\n"
        
        if chat_history:
            conversation += "Previous conversation:\n"
            for message in chat_history[-6:]:
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

def generate_llm_response(chat_history: List[Dict[str, str]], new_message: str, max_retries: int = 2) -> Tuple[bool, str, str]:
    """Generate LLM response with retry logic and error handling"""
    try:
        client = genai.Client()
    except Exception as e:
        logger.error(f"Failed to initialize Gemini client: {e}")
        return False, FALLBACK_RESPONSES["api_unavailable"], "api_unavailable"
    
    prompt = format_chat_history_for_llm(chat_history, new_message)
    
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
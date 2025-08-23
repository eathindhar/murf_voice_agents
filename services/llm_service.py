# services/llm.py
import google.generativeai as genai
import websockets
import json
import asyncio
import re
import logging
import os
import time
from typing import List, Dict, Any, Tuple
from dotenv import load_dotenv

load_dotenv()
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
MURF_API_KEY = os.getenv("MURF_API_KEY")

logger = logging.getLogger(__name__)

if GEMINI_API_KEY:
    genai.configure(api_key=GEMINI_API_KEY)
else:
    print("Warning: GEMINI_API_KEY not found in .env file.")

def get_llm_response(user_query: str, history: List[Dict[str, Any]]) -> Tuple[str, List[Dict[str, Any]]]:
    """Gets a response from the Gemini LLM and updates chat history."""
    model = genai.GenerativeModel('gemini-2.0-flash')
    chat = model.start_chat(history=history)
    response = chat.send_message(user_query)
    return response.text, chat.history


async def receive_loop(ws):
    """Receive audio chunks from Murf WebSocket"""
    audio_chunks = []
    chunk_count = 1
    start_time = time.time()
    
    try:
        while True:
            try:
                # Add timeout to prevent hanging
                response = await asyncio.wait_for(ws.recv(), timeout=30.0)
                data = json.loads(response)
                
                if "audio" in data and data["audio"]:
                    base64_chunk = data["audio"]
                    max_len = 64
                    if len(base64_chunk) > max_len:
                        truncated_chunk = f"{base64_chunk[:30]}...{base64_chunk[-30:]}"
                    else:
                        truncated_chunk = base64_chunk
                    print(f"[murf ai][chunk {chunk_count}] {truncated_chunk}")
                    audio_chunks.append(base64_chunk)
                    chunk_count += 1
                
                if data.get("final"):
                    total_time = time.time() - start_time
                    logger.info(f"Murf confirms final audio chunk received. Total time: {total_time:.2f}s")
                    break
                    
            except asyncio.TimeoutError:
                logger.error("Timeout waiting for Murf response")
                break
                
    except websockets.exceptions.ConnectionClosed:
        logger.warning("Murf WebSocket connection closed unexpectedly")
    except Exception as e:
        logger.error(f"Error in receive loop: {str(e)}")
    
    return audio_chunks


async def get_llm_response_with_murf(user_query: str, history: List[Dict[str, Any]]) -> Tuple[str, List[Dict[str, Any]], List[str]]:
    """Gets a response from the Gemini LLM and updates chat history, including audio chunks."""
    if not GEMINI_API_KEY:
        raise ValueError("Gemini API key is missing.")
    if not MURF_API_KEY:
        raise ValueError("Murf API key is missing.")
    
    start_time = time.time()
    context_id = ""

    try:
        print(f"\n=== Starting LLM Response Generation ===")
        print(f"Query: {user_query}")
        
        # Connect to Murf WebSocket
        uri = (
            f"wss://api.murf.ai/v1/speech/stream-input"
            f"?api-key={MURF_API_KEY}"
            f"&sample_rate=44100"
            f"&channel_type=MONO"
            f"&format=MP3"
        )
        
        print(f"Connecting to Murf WebSocket...")
        connect_start = time.time()
        
        async with websockets.connect(uri) as ws:
            connect_time = time.time() - connect_start
            print(f"Murf WebSocket connected in {connect_time:.2f}s")
            
            # Send voice configuration
            voice_config = {
                "context_id": context_id,
                "voice_config": {
                    "voiceId": "en-US-darnell",
                    "style": "Conversational"
                }
            }
            await ws.send(json.dumps(voice_config))
            print("Voice config sent to Murf")
            
            # Start the audio receiver task
            receiver_task = asyncio.create_task(receive_loop(ws))
            
            # Generate streaming response from Gemini
            print("Starting Gemini streaming response...")
            gemini_start = time.time()
            
            model = genai.GenerativeModel('gemini-1.5-flash')
            chat = model.start_chat(history=history)
            stream = chat.send_message(user_query, stream=True)
            
            sentence_buffer = ""
            accumulated_response = ""
            sentences_sent = 0
            
            print("\n=== GEMINI STREAMING RESPONSE ===")
            for chunk in stream:
                if chunk.text:
                    accumulated_response += chunk.text
                    sentence_buffer += chunk.text
                    print(chunk.text, end="", flush=True)

                    # Split into sentences using regex
                    sentences = re.split(r'(?<=[.?!])\s+', sentence_buffer)

                    if len(sentences) > 1:
                        # Send complete sentences to Murf
                        for sentence in sentences[:-1]:
                            if sentence.strip():
                                sentences_sent += 1
                                text_msg = {
                                    "context_id": context_id,
                                    "text": sentence.strip(),
                                    "end": False
                                }
                                await ws.send(json.dumps(text_msg))
                                print(f"\n[Sent sentence {sentences_sent} to Murf: '{sentence.strip()[:50]}...']")
                        sentence_buffer = sentences[-1]

            gemini_time = time.time() - gemini_start
            print(f"\n=== GEMINI STREAM COMPLETED in {gemini_time:.2f}s ===")

            # Send final sentence buffer if any
            if sentence_buffer.strip():
                sentences_sent += 1
                text_msg = {
                    "context_id": context_id,
                    "text": sentence_buffer.strip(),
                    "end": True
                }
                await ws.send(json.dumps(text_msg))
                print(f"[Sent final sentence {sentences_sent} to Murf: '{sentence_buffer.strip()[:50]}...']")

            print(f"Total sentences sent to Murf: {sentences_sent}")
            print("Waiting for Murf audio chunks...")
            
            # Wait for all audio chunks from Murf with timeout
            try:
                audio_chunks = await asyncio.wait_for(receiver_task, timeout=60.0)
            except asyncio.TimeoutError:
                logger.error("Timeout waiting for Murf audio chunks")
                audio_chunks = []

            total_time = time.time() - start_time
            print(f"\n=== COMPLETE PIPELINE TIME: {total_time:.2f}s ===")
            print(f"Audio chunks received: {len(audio_chunks)}")

            if not accumulated_response:
                raise ValueError("No response from Gemini LLM stream.")

            return accumulated_response, chat.history, audio_chunks

    except genai.types.generation_types.BlockedPromptException as e:
        logger.error(f"Gemini blocked prompt: {str(e)}")
        raise
    except genai.types.generation_types.StopCandidateException as e:
        logger.error(f"Gemini stopped generation: {str(e)}")
        raise
    except websockets.exceptions.ConnectionClosed as e:
        logger.error(f"Murf WebSocket closed: {str(e)}")
        raise
    except asyncio.TimeoutError as e:
        logger.error(f"Timeout in LLM processing: {str(e)}")
        raise
    except Exception as e:
        logger.error(f"Unexpected error: {str(e)}")
        raise
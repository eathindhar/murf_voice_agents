import logging
import asyncio
import json
from typing import Callable, Optional, Type
import assemblyai as aai
from assemblyai.streaming.v3 import (
    BeginEvent,
    StreamingClient,
    StreamingClientOptions,
    StreamingError,
    StreamingEvents,
    StreamingParameters,
    TerminationEvent,
    TurnEvent,
)

logger = logging.getLogger(__name__)

class StreamingSTTService:
    def __init__(self, api_key: str):
        """Initialize the streaming STT service with AssemblyAI Universal-Streaming"""
        if not api_key:
            raise ValueError("AssemblyAI API key is required")
        
        self.api_key = api_key
        self.client: Optional[StreamingClient] = None
        self.is_connected = False
        self.session_id: Optional[str] = None
        self.transcript_callback: Optional[Callable] = None
        self.error_callback: Optional[Callable] = None
        
    async def start_streaming_transcription(
        self, 
        session_id: str,
        transcript_callback: Callable[[str, dict], None],
        error_callback: Optional[Callable[[str, str], None]] = None
    ) -> bool:
        """
        Start streaming transcription for a session using Universal-Streaming
        
        Args:
            session_id: Unique session identifier
            transcript_callback: Function to call with transcription results
            error_callback: Function to call with errors
            
        Returns:
            bool: True if started successfully, False otherwise
        """
        try:
            self.session_id = session_id
            self.transcript_callback = transcript_callback
            self.error_callback = error_callback
            
            # Create streaming client with Universal-Streaming v3 API
            client_options = StreamingClientOptions(
                api_key=self.api_key,
                api_host="streaming.assemblyai.com"
            )
            
            self.client = StreamingClient(client_options)
            
            # Set up event handlers using the correct format
            self.client.on(StreamingEvents.Begin, self._on_begin)
            self.client.on(StreamingEvents.Turn, self._on_turn)
            self.client.on(StreamingEvents.Termination, self._on_terminated)
            self.client.on(StreamingEvents.Error, self._on_error)
            
            # Configure streaming parameters
            streaming_params = StreamingParameters(
                sample_rate=16000,
                format_turns=False,  # Set to True if you want formatted text with punctuation
                end_of_turn_confidence_threshold=0.8,
                min_end_of_turn_silence_when_confident=500,  # milliseconds
                max_turn_silence=2000,  # milliseconds
            )
            
            # Connect to Universal-Streaming
            await asyncio.get_event_loop().run_in_executor(
                None, self.client.connect, streaming_params
            )
            
            logger.info(f"Started Universal-Streaming transcription for session: {session_id}")
            return True
            
        except Exception as e:
            logger.error(f"Failed to start Universal-Streaming transcription: {e}")
            if self.error_callback:
                try:
                    await self.error_callback(session_id, f"Failed to start transcription: {str(e)}")
                except Exception as callback_error:
                    logger.error(f"Error in error callback: {callback_error}")
            return False
    
    async def stream_audio_chunk(self, audio_data: bytes) -> bool:
        """
        Stream audio chunk to AssemblyAI Universal-Streaming
        
        Args:
            audio_data: Raw audio bytes
            
        Returns:
            bool: True if successfully streamed, False otherwise
        """
        try:
            if not self.client or not self.is_connected:
                logger.warning("Universal-Streaming client not connected, cannot stream audio")
                return False
            
            # Stream audio data to Universal-Streaming
            await asyncio.get_event_loop().run_in_executor(
                None, self.client.stream, audio_data
            )
            
            return True
            
        except Exception as e:
            logger.error(f"Error streaming audio chunk to Universal-Streaming: {e}")
            if self.error_callback and self.session_id:
                try:
                    await self.error_callback(self.session_id, f"Streaming error: {str(e)}")
                except Exception as callback_error:
                    logger.error(f"Error in error callback: {callback_error}")
            return False
    
    async def stop_streaming_transcription(self) -> dict:
        """
        Stop Universal-Streaming transcription and cleanup
        
        Returns:
            dict: Final transcription summary
        """
        try:
            summary = {
                "session_id": self.session_id,
                "status": "stopped",
                "final_transcript": ""
            }
            
            if self.client:
                # Disconnect from Universal-Streaming (correct method)
                await asyncio.get_event_loop().run_in_executor(
                    None, self.client.disconnect, True  # terminate=True
                )
                
                summary["status"] = "completed"
                logger.info(f"Stopped Universal-Streaming transcription for session: {self.session_id}")
            
            # Reset state
            self.client = None
            self.is_connected = False
            self.session_id = None
            self.transcript_callback = None
            self.error_callback = None
            
            return summary
            
        except Exception as e:
            logger.error(f"Error stopping Universal-Streaming transcription: {e}")
            return {
                "session_id": self.session_id,
                "status": "error",
                "error": str(e)
            }
    
    def _on_begin(self, client: Type[StreamingClient], event: BeginEvent):
        """Called when the Universal-Streaming session begins"""
        logger.info(f"Universal-Streaming session opened: {event.id}")
        self.is_connected = True
    
    def _on_turn(self, client: Type[StreamingClient], event: TurnEvent):
        """Called when transcription data is received from Universal-Streaming"""
        try:
            if not event.transcript:
                return
            
            # Universal-Streaming provides immutable transcripts
            # end_of_turn indicates if this is the final transcript for this turn
            is_final = event.end_of_turn
            
            transcript_data = {
                "text": event.transcript,
                "confidence": getattr(event, 'end_of_turn_confidence', 0.0),
                "is_final": is_final,
                "turn_order": getattr(event, 'turn_order', 0),
                "timestamp": None,  # Universal-Streaming doesn't provide timestamps in the same way
                "session_id": self.session_id
            }
            
            # Log to console
            status = "FINAL" if is_final else "PARTIAL"
            logger.info(f"[{status}] Universal-Streaming for {self.session_id}: {event.transcript}")
            
            # Call the callback function safely
            if self.transcript_callback and self.session_id:
                # Use asyncio.run_coroutine_threadsafe for thread-safe async calls
                try:
                    import threading
                    
                    def run_callback_safely():
                        try:
                            # Create a new event loop for this thread
                            loop = asyncio.new_event_loop()
                            asyncio.set_event_loop(loop)
                            
                            # Run the callback
                            loop.run_until_complete(
                                self.transcript_callback(self.session_id, transcript_data)
                            )
                            
                            # Clean up
                            loop.close()
                        except Exception as e:
                            logger.error(f"Error in callback thread: {e}")
                    
                    # Run in a separate thread to avoid blocking
                    thread = threading.Thread(target=run_callback_safely, daemon=True)
                    thread.start()
                    
                except Exception as e:
                    logger.error(f"Error setting up callback thread: {e}")
            
        except Exception as e:
            logger.error(f"Error processing Universal-Streaming transcript data: {e}")
    
    def _on_terminated(self, client: Type[StreamingClient], event: TerminationEvent):
        """Called when the Universal-Streaming session terminates"""
        logger.info(f"Universal-Streaming session terminated: {event.audio_duration_seconds} seconds of audio processed")
        self.is_connected = False
    
    def _on_error(self, client: Type[StreamingClient], error: StreamingError):
        """Called when a Universal-Streaming error occurs"""
        error_msg = f"Universal-Streaming error: {error}"
        logger.error(error_msg)
        
        if self.error_callback and self.session_id:
            try:
                import threading
                
                def run_error_callback_safely():
                    try:
                        # Create a new event loop for this thread
                        loop = asyncio.new_event_loop()
                        asyncio.set_event_loop(loop)
                        
                        # Run the error callback
                        loop.run_until_complete(
                            self.error_callback(self.session_id, error_msg)
                        )
                        
                        # Clean up
                        loop.close()
                    except Exception as e:
                        logger.error(f"Error in error callback thread: {e}")
                
                # Run in a separate thread to avoid blocking
                thread = threading.Thread(target=run_error_callback_safely, daemon=True)
                thread.start()
                
            except Exception as e:
                logger.error(f"Error setting up error callback thread: {e}")


# Singleton instance for managing streaming sessions
class StreamingSTTManager:
    def __init__(self):
        self.sessions: dict = {}
        self.api_key: Optional[str] = None
    
    def initialize(self, api_key: str):
        """Initialize the manager with API key"""
        self.api_key = api_key
    
    async def start_session(
        self, 
        session_id: str, 
        transcript_callback: Callable,
        error_callback: Optional[Callable] = None
    ) -> bool:
        """Start a new Universal-Streaming transcription session"""
        if not self.api_key:
            logger.error("STT Manager not initialized with API key")
            return False
        
        if session_id in self.sessions:
            logger.warning(f"Session {session_id} already exists")
            return False
        
        try:
            stt_service = StreamingSTTService(self.api_key)
            success = await stt_service.start_streaming_transcription(
                session_id, transcript_callback, error_callback
            )
            
            if success:
                self.sessions[session_id] = stt_service
                return True
            else:
                return False
                
        except Exception as e:
            logger.error(f"Failed to start Universal-Streaming session {session_id}: {e}")
            return False
    
    async def stream_audio(self, session_id: str, audio_data: bytes) -> bool:
        """Stream audio data to a Universal-Streaming session"""
        if session_id not in self.sessions:
            logger.warning(f"Universal-Streaming session {session_id} not found")
            return False
        
        return await self.sessions[session_id].stream_audio_chunk(audio_data)
    
    async def stop_session(self, session_id: str) -> dict:
        """Stop a Universal-Streaming transcription session"""
        if session_id not in self.sessions:
            logger.warning(f"Universal-Streaming session {session_id} not found")
            return {"status": "not_found", "session_id": session_id}
        
        try:
            summary = await self.sessions[session_id].stop_streaming_transcription()
            del self.sessions[session_id]
            return summary
        except Exception as e:
            logger.error(f"Error stopping Universal-Streaming session {session_id}: {e}")
            return {"status": "error", "session_id": session_id, "error": str(e)}
    
    def get_active_sessions(self) -> list:
        """Get list of active session IDs"""
        return list(self.sessions.keys())

# Global manager instance
streaming_stt_manager = StreamingSTTManager()
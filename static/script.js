// static/script.js

document.addEventListener("DOMContentLoaded", async () => {
    // --- SESSION MANAGEMENT ---
    const urlParams = new URLSearchParams(window.location.search);
    let sessionId = urlParams.get('session_id');
    if (!sessionId) {
        sessionId = crypto.randomUUID();
        window.history.replaceState({}, '', `?session_id=${sessionId}`);
    }

    // --- WebSocket and Recording Logic ---
    let audioContext = null;
    let source = null;
    let processor = null;
    let isRecording = false;
    let socket = null;

    // --- Audio Playback Logic ---
    let playbackContext = null;
    let nextStartTime = 0;
    let isPlayingAudio = false;

    const recordBtn = document.getElementById("recordBtn");
    const cancelBtn = document.getElementById("cancelBtn");
    const statusDisplay = document.getElementById("statusDisplay");
    const processingStatus = document.getElementById("processingStatus");
    const chatArea = document.getElementById("chatArea");

    // Initialize audio playback context
    const initPlaybackContext = () => {
        if (!playbackContext) {
            playbackContext = new (window.AudioContext || window.webkitAudioContext)();
            nextStartTime = 0;
        }
    };

    // Play audio chunk seamlessly
    const playAudioChunk = async (base64AudioData) => {
        try {
            initPlaybackContext();
            
            // Resume context if suspended (required by some browsers)
            if (playbackContext.state === 'suspended') {
                await playbackContext.resume();
            }

            // Decode base64 to array buffer
            const binaryString = atob(base64AudioData);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
                bytes[i] = binaryString.charCodeAt(i);
            }

            // Decode audio data
            const audioBuffer = await playbackContext.decodeAudioData(bytes.buffer);
            
            // Create buffer source
            const source = playbackContext.createBufferSource();
            source.buffer = audioBuffer;
            source.connect(playbackContext.destination);

            // Calculate when to start this chunk
            const currentTime = playbackContext.currentTime;
            const startTime = Math.max(currentTime, nextStartTime);
            
            // Start playback
            source.start(startTime);
            
            // Update next start time for seamless playback
            nextStartTime = startTime + audioBuffer.duration;
            
            console.log(`Playing audio chunk at ${startTime.toFixed(3)}s, duration: ${audioBuffer.duration.toFixed(3)}s`);
            
        } catch (error) {
            console.error('Error playing audio chunk:', error);
        }
    };

    // Reset audio playback state
    const resetAudioPlayback = () => {
        nextStartTime = 0;
        isPlayingAudio = false;
        if (playbackContext) {
            // Don't close the context, just reset the timing
            nextStartTime = playbackContext.currentTime;
        }
    };

    // Helper function to format timestamp (MM:SS format)
    const formatTimestamp = () => {
        const now = new Date();
        const minutes = String(now.getMinutes()).padStart(2, '0');
        const seconds = String(now.getSeconds()).padStart(2, '0');
        return `${minutes}:${seconds}`;
    };

    // Add transcription as chat bubble
    const addTranscriptionBubble = (text, isFinal = false, turnData = null) => {
        if (!text.trim()) return;

        // Remove welcome message if it exists
        const welcomeMessage = chatArea.querySelector('.welcome-message');
        if (welcomeMessage) {
            welcomeMessage.remove();
        }

        const timestamp = formatTimestamp();
        
        // Create bubble element
        const bubble = document.createElement('div');
        bubble.className = 'chat-bubble transcription-bubble';
        
        const bubbleText = document.createElement('div');
        bubbleText.className = 'bubble-text';
        bubbleText.textContent = `${timestamp} : "${text}"`;
        
        const bubbleTimestamp = document.createElement('div');
        bubbleTimestamp.className = 'bubble-timestamp';
        bubbleTimestamp.textContent = new Date().toLocaleTimeString('en-US', { 
            hour12: true, 
            hour: 'numeric', 
            minute: '2-digit' 
        });
        
        // Add turn metadata if available
        if (turnData && isFinal) {
            const metadata = document.createElement('div');
            metadata.className = 'turn-metadata';
            metadata.innerHTML = `
                <small>Turn ID: ${turnData.turn_id || 'N/A'} | 
                Confidence: ${turnData.confidence ? (turnData.confidence * 100).toFixed(1) + '%' : 'N/A'} | 
                Duration: ${turnData.audio_duration ? turnData.audio_duration.toFixed(2) + 's' : 'N/A'}</small>
            `;
            bubble.appendChild(metadata);
        }
        
        bubble.appendChild(bubbleText);
        bubble.appendChild(bubbleTimestamp);
        
        chatArea.appendChild(bubble);
        
        // Auto-scroll to bottom
        chatArea.scrollTop = chatArea.scrollHeight;
    };

    const startRecording = async () => {
        if (!navigator.mediaDevices?.getUserMedia) {
            alert("Audio recording not supported in this browser.");
            return;
        }

        isRecording = true;
        recordBtn.classList.add("recording");
        cancelBtn.classList.remove("d-none");
        statusDisplay.textContent = "Connecting to transcription service...";
        statusDisplay.classList.remove("error");

        // Reset audio playback for new session
        resetAudioPlayback();

        try {
            // Establish WebSocket connection
            const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
            socket = new WebSocket(`${wsProtocol}//${window.location.host}/ws`);

            socket.onopen = async () => {
                console.log("WebSocket connection established for streaming transcription.");
                statusDisplay.textContent = "🎤 Listening... Speak now!";

                try {
                    // Get microphone access
                    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                    
                    // Create AudioContext with 16kHz sample rate (required by AssemblyAI)
                    audioContext = new (window.AudioContext || window.webkitAudioContext)({ 
                        sampleRate: 16000 
                    });
                    
                    source = audioContext.createMediaStreamSource(stream);
                    
                    // Create ScriptProcessorNode for processing audio chunks
                    processor = audioContext.createScriptProcessor(4096, 1, 1);

                    processor.onaudioprocess = (event) => {
                        const inputData = event.inputBuffer.getChannelData(0);
                        
                        // Convert float32 (-1.0 to 1.0) to 16-bit PCM
                        const pcmData = new Int16Array(inputData.length);
                        for (let i = 0; i < inputData.length; i++) {
                            const sample = Math.max(-1, Math.min(1, inputData[i]));
                            pcmData[i] = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
                        }
                        
                        // Send PCM data to server if WebSocket is open
                        if (socket && socket.readyState === WebSocket.OPEN) {
                            socket.send(pcmData.buffer);
                        }
                    };

                    // Connect the audio nodes
                    source.connect(processor);
                    processor.connect(audioContext.destination);

                    // Store the stream for cleanup
                    recordBtn.mediaStream = stream;

                } catch (micError) {
                    console.error("Error accessing microphone:", micError);
                    showError("Could not access microphone. Please check permissions.");
                    stopRecording();
                }
            };

            // Handle messages from the WebSocket (transcription updates and audio chunks)
            socket.onmessage = (event) => {
                console.log("Received WebSocket message:", event.data);
                try {
                    const data = JSON.parse(event.data);
                    console.log("Parsed message data:", data);
                    
                    if (data.type === "transcription") {
                        // Check if this is a turn event with turn object
                        const turnData = data.turn || null;
                        
                        // Log turn information if available
                        if (turnData && data.is_final) {
                            console.log("Turn Object Data:", {
                                turn_id: turnData.turn_id,
                                confidence: turnData.confidence,
                                audio_duration: turnData.audio_duration,
                                start_time: turnData.start_time,
                                end_time: turnData.end_time,
                                speaker: turnData.speaker,
                                channel: turnData.channel
                            });
                        }
                        
                        // Add transcription with turn data
                        addTranscriptionBubble(data.text, data.is_final, turnData);
                        console.log(`Transcription ${data.is_final ? '(final)' : '(partial)'}: ${data.text}`);
                        
                    } else if (data.type === "audio_chunk") {
                        // Handle audio chunk playback
                        console.log(`Received audio chunk ${data.chunk_index}/${data.total_chunks}`);
                        
                        if (data.audio_data) {
                            // Play the audio chunk immediately
                            playAudioChunk(data.audio_data);
                            
                            if (!isPlayingAudio) {
                                isPlayingAudio = true;
                                statusDisplay.textContent = "🔊 Playing AI response...";
                            }
                        }
                        
                    } else if (data.type === "audio_complete") {
                        // Handle audio streaming completion
                        console.log(`AUDIO STREAMING COMPLETED`);
                        console.log(`Total chunks received: ${data.total_chunks}`);
                        
                        statusDisplay.textContent = "AI response received. Continue speaking or stop recording.";
                        isPlayingAudio = false;
                        
                    } else if (data.type === "turn_end") {
                        // Handle turn end - prepare for next interaction
                        console.log("Turn ended, ready for next input");
                        
                    } else if (data.type === "error") {
                        console.error("Transcription error:", data.message);
                        showError(`Transcription error: ${data.message}`);
                    } else if (data.type === "status") {
                        console.log("Status message:", data.message);
                        statusDisplay.textContent = data.message;
                    }
                } catch (err) {
                    console.error("Error parsing WebSocket message:", err, "Raw data:", event.data);
                }
            };

            socket.onclose = () => {
                console.log("WebSocket connection closed.");
                if (isRecording) {
                    statusDisplay.textContent = "Session ended";
                }
            };

            socket.onerror = (error) => {
                console.error("WebSocket error:", error);
                showError("Connection error occurred");
            };

        } catch (err) {
            console.error("Error starting recording:", err);
            showError("Failed to start recording session");
            stopRecording();
        }
    };

    const stopRecording = () => {
        if (!isRecording) return;

        isRecording = false;
        recordBtn.classList.remove("recording");
        cancelBtn.classList.add("d-none");
        statusDisplay.textContent = "Processing...";
        statusDisplay.classList.remove("error");
        processingStatus.classList.remove("d-none");

        // Clean up audio processing
        if (processor) {
            processor.disconnect();
            processor = null;
        }
        
        if (source) {
            source.disconnect();
            source = null;
        }
        
        if (audioContext) {
            audioContext.close();
            audioContext = null;
        }

        // Stop media stream tracks
        if (recordBtn.mediaStream) {
            recordBtn.mediaStream.getTracks().forEach(track => track.stop());
            recordBtn.mediaStream = null;
        }

        // Send EOF and close WebSocket
        if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send("EOF");
            socket.close();
        }
        socket = null;

        // Reset status after a delay
        setTimeout(() => {
            statusDisplay.textContent = "Ready to chat!";
            processingStatus.classList.add("d-none");
        }, 2000);
    };

    const showError = (message) => {
        statusDisplay.textContent = message;
        statusDisplay.classList.add("error");
        processingStatus.classList.add("d-none");
        
        // Clear error styling after a few seconds
        setTimeout(() => {
            statusDisplay.classList.remove("error");
            if (!isRecording) {
                statusDisplay.textContent = "Ready to chat!";
            }
        }, 5000);
    };

    // Event listeners
    recordBtn.addEventListener("click", () => {
        if (isRecording) {
            stopRecording();
        } else {
            startRecording();
        }
    });

    cancelBtn.addEventListener("click", () => {
        if (isRecording) {
            stopRecording();
        }
    });

    // Clean up on page unload
    window.addEventListener('beforeunload', () => {
        if (isRecording) {
            stopRecording();
        }
        if (playbackContext) {
            playbackContext.close();
        }
    });
});
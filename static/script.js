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
    let audioQueue = [];
    let isPlayingAudio = false;
    let currentAudio = null;

    const recordBtn = document.getElementById("recordBtn");
    const cancelBtn = document.getElementById("cancelBtn");
    const statusDisplay = document.getElementById("statusDisplay");
    const processingStatus = document.getElementById("processingStatus");
    const chatArea = document.getElementById("chatArea");
    const pipelineStatus = document.getElementById("pipelineStatus");

    // Pipeline status management
    const updatePipelineStatus = (stage, message) => {
        const pipelineText = pipelineStatus.querySelector('.pipeline-text');
        
        // Remove all status classes
        pipelineStatus.className = 'pipeline-status';
        
        switch(stage) {
            case 'transcribing':
                pipelineStatus.classList.add('transcribing');
                pipelineText.textContent = '🎤 ' + (message || 'Live transcription...');
                break;
            case 'processing':
                pipelineStatus.classList.add('processing');
                pipelineText.textContent = '🧠 ' + (message || 'Sent to Gemini AI...');
                break;
            case 'responding':
                pipelineStatus.classList.add('responding');
                pipelineText.textContent = '💭 ' + (message || 'Received Gemini response...');
                break;
            case 'converting':
                pipelineStatus.classList.add('converting');
                pipelineText.textContent = '🔄 ' + (message || 'Converting response to audio...');
                break;
            case 'playing':
                pipelineStatus.classList.add('playing');
                pipelineText.textContent = '🔊 ' + (message || 'Audio received and playing...');
                break;
            case 'hide':
            default:
                pipelineStatus.classList.add('d-none');
                return;
        }
        
        pipelineStatus.classList.remove('d-none');
    };

    // Play audio chunk using HTML Audio API with sequential playback
    const playAudioChunk = async (base64AudioData) => {
        try {
            console.log(`Received audio chunk of size: ${base64AudioData.length} chars`);
            
            // Validate base64 data
            if (!base64AudioData || base64AudioData.length === 0) {
                console.error('Empty audio data received');
                return;
            }
            
            // Convert base64 to blob
            const binaryString = atob(base64AudioData);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
                bytes[i] = binaryString.charCodeAt(i);
            }

            console.log(`Binary data size: ${bytes.length} bytes`);

            // Create audio blob (try MP3 first since we changed the backend format)
            const audioBlob = new Blob([bytes], { type: 'audio/mpeg' });
            const audioUrl = URL.createObjectURL(audioBlob);
            
            // Add to queue for sequential playback
            audioQueue.push({
                url: audioUrl,
                blob: audioBlob,
                data: bytes
            });
            
            console.log(`Added audio chunk to queue. Queue length: ${audioQueue.length}`);
            
            // Start playing if not already playing
            if (!isPlayingAudio) {
                console.log('Starting sequential audio playback');
                playNextAudioChunk();
            }
            
        } catch (error) {
            console.error('Error processing audio chunk:', error);
        }
    };

    // Simplified audio queue - remove for now since we're testing direct playback
    // Play next audio chunk in queue
    const playNextAudioChunk = () => {
        // Removed queue system for direct testing
        console.log('Queue system disabled for debugging');
    };

    // Reset audio playback state
    const resetAudioPlayback = () => {
        console.log('Resetting audio playback state');
        isPlayingAudio = false;
        
        // Clear the queue
        audioQueue.forEach(item => {
            if (item.url) {
                URL.revokeObjectURL(item.url);
            }
        });
        audioQueue = [];
        
        // Stop current audio if playing
        if (currentAudio) {
            currentAudio.pause();
            currentAudio = null;
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
                updatePipelineStatus('transcribing', 'Live transcription active...');

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
                        
                        // Update pipeline status when we get a final transcription
                        if (data.is_final && data.end_of_turn) {
                            updatePipelineStatus('processing', 'Sent to Gemini AI...');
                            
                            // Set a timeout to show "waiting for response" if no audio comes quickly
                            setTimeout(() => {
                                if (!isPlayingAudio) {
                                    updatePipelineStatus('responding', 'Waiting for Gemini response...');
                                }
                            }, 1000);
                            
                            // Set another timeout to show "converting" if still waiting
                            setTimeout(() => {
                                if (!isPlayingAudio) {
                                    updatePipelineStatus('converting', 'Converting response to audio...');
                                }
                            }, 3000);
                        }
                        
                    } else if (data.type === "turn_end") {
                        // This indicates the turn has ended, response should be coming
                        console.log("Turn ended, response should be generating...");
                        
                    } else if (data.type === "audio_chunk") {
                        // Handle audio chunk playback
                        console.log(`Received audio chunk ${data.chunk_index}/${data.total_chunks}`);
                        
                        if (data.audio_data) {
                            // Update status on first chunk - this means Murf has started generating
                            if (data.chunk_index === 1) {
                                console.log("First audio chunk received - Murf generation started");
                                updatePipelineStatus('playing', `Audio received and playing... (1/${data.total_chunks})`);
                                isPlayingAudio = true;
                                statusDisplay.textContent = "🔊 Playing AI response...";
                            } else {
                                updatePipelineStatus('playing', `Audio received and playing... (${data.chunk_index}/${data.total_chunks})`);
                            }
                            
                            // Play the audio chunk immediately
                            playAudioChunk(data.audio_data);
                        }
                        
                    } else if (data.type === "audio_complete") {
                        // Handle audio streaming completion
                        console.log(`AUDIO STREAMING COMPLETED`);
                        console.log(`Total chunks received: ${data.total_chunks}`);
                        
                        statusDisplay.textContent = "AI response received. Continue speaking or stop recording.";
                        isPlayingAudio = false;
                        
                        // Hide pipeline status after a short delay
                        setTimeout(() => {
                            updatePipelineStatus('hide');
                        }, 2000);
                        
                    } else if (data.type === "error") {
                        console.error("Transcription error:", data.message);
                        showError(`Transcription error: ${data.message}`);
                        updatePipelineStatus('hide');
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
                updatePipelineStatus('hide');
            };

            socket.onerror = (error) => {
                console.error("WebSocket error:", error);
                showError("Connection error occurred");
                updatePipelineStatus('hide');
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

        // Hide pipeline status
        updatePipelineStatus('hide');

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
        updatePipelineStatus('hide');
        
        // Clear error styling after a few seconds
        setTimeout(() => {
            statusDisplay.classList.remove("error");
            if (!isRecording) {
                statusDisplay.textContent = "Ready to chat!";
            }
        }, 5000);
    };

    // Test audio playback with a simple beep
    const testAudioPlayback = () => {
        // Create a simple test audio
        const testAudio = new Audio('data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQoGAACBhYqFbF1fdJivrJBhNjVgodDbq2EcBj+a2/LDciUFLIHO8tiJNwgZaLvt559NEAxQp+PwtmMcBjiR1/LMeSwFJHfH8N2QQAoUXrTp66hVFApGn+DyvmMdBTOG0fPTgjMGHm7A7+OZURE');
        testAudio.volume = 0.3;
        testAudio.play().then(() => {
            console.log('Test audio played successfully');
        }).catch(e => {
            console.error('Test audio failed:', e);
        });
    };

    // Add test button click handler (temporary)
    recordBtn.addEventListener('dblclick', () => {
        console.log('Testing audio playback...');
        testAudioPlayback();
    });

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
        // Clean up audio resources
        resetAudioPlayback();
    });
});
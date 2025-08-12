// When the button is clicked, change the heading and show a thank-you message
document.addEventListener("DOMContentLoaded", () => {
  const button = document.getElementById("cta-btn");
  const input = document.getElementById("text-input");
  const audioPlayer = document.getElementById("audio-player");
  const loader = document.getElementById("loader");
  const btnText = document.getElementById("btn-text");
  let selectedVoice = "en-US-natalie";

  // New elements for recording functionality
  const startButton = document.getElementById("recordButton");
  const stopButton = document.getElementById("stopButton");
  const audioPlayback = document.getElementById("audio-player1"); // LLM bot audio player
  const message = document.getElementById("message");

  // Session management variables
  let currentSessionId = getOrCreateSessionId();
  let isConversationActive = false;
  let autoRecordingEnabled = false;

  let mediaRecorder;
  let audioChunks = [];

  // Update session display
  updateSessionDisplay();

  // Function to get or create session ID from URL
  function getOrCreateSessionId() {
    const urlParams = new URLSearchParams(window.location.search);
    let sessionId = urlParams.get('session_id');
    
    if (!sessionId) {
      // Generate new session ID
      sessionId = 'session_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
      // Update URL without refreshing the page
      urlParams.set('session_id', sessionId);
      window.history.replaceState({}, '', `${window.location.pathname}?${urlParams}`);
    }
    
    console.log('Current session ID:', sessionId);
    return sessionId;
  }

  // Function to update session display
  function updateSessionDisplay() {
    const sessionDisplay = document.getElementById("session-display");
    if (sessionDisplay) {
      sessionDisplay.textContent = `Session: ${currentSessionId}`;
    }
  }

  // Function to start new session
  function startNewSession() {
    const newSessionId = 'session_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    const urlParams = new URLSearchParams(window.location.search);
    urlParams.set('session_id', newSessionId);
    window.history.replaceState({}, '', `${window.location.pathname}?${urlParams}`);
    currentSessionId = newSessionId;
    updateSessionDisplay();
    
    // Clear conversation display
    const transcriptionDisplay = document.getElementById("transcription-display");
    if (transcriptionDisplay) {
      transcriptionDisplay.innerHTML = "";
      transcriptionDisplay.style.display = "none";
    }
    
    console.log('Started new session:', currentSessionId);
    message.textContent = "New session started! Ready to chat.";
  }

  // Add new session button functionality
  const newSessionButton = document.getElementById("newSessionButton");
  if (newSessionButton) {
    newSessionButton.addEventListener("click", startNewSession);
  }

  // Function to auto-start recording after audio playback ends
  function setupAutoRecording() {
    if (audioPlayback && !autoRecordingEnabled) {
      audioPlayback.addEventListener('ended', () => {
        if (isConversationActive) {
          console.log('Audio playback ended, auto-starting recording...');
          setTimeout(() => {
            if (!startButton.disabled) {
              startButton.click();
            }
          }, 1000); // 1 second delay before auto-recording
        }
      });
      autoRecordingEnabled = true;
    }
  }

  // --- Existing Voice Selection Logic ---
  const voiceButtons = document.querySelectorAll(".voice-btn");
  voiceButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      voiceButtons.forEach((b) => b.classList.remove("selected"));
      btn.classList.add("selected");
      selectedVoice = btn.getAttribute("data-voice");
      console.log("Selected voice:", selectedVoice);
    });
  });

  // --- Existing Text-to-Speech Logic ---
  button.addEventListener("click", async () => {
    const text = input.value.trim();
    if (!text) {
      alert("Please enter some text to generate audio.");
      return;
    }

    // Show loader
    loader.style.display = "inline-block";
    btnText.textContent = "Generating...";
    button.disabled = true;

    try {
      const response = await fetch("/generate-audio", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ text: text, voice_id: selectedVoice }),
      });
      console.log({
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ text: text, voice_id: selectedVoice }),
      });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.detail || "Failed to generate audio.");
      }
      const data = await response.json();
      audioPlayer.src = data.audio_url;
      audioPlayer.style.display = "block";
      audioPlayer.play();
    } catch (error) {
      console.error("Error generating audio:", error);
      alert("An error occurred while generating audio: " + error.message);
    } finally {
      // ✅ Always stop loader, re-enable button
      loader.style.display = "none";
      btnText.textContent = "Generate Audio";
      button.disabled = false;
    }
  });

  // --- NEW Audio Recording Logic for Conversational Chat ---

  // Check for browser support
  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    console.log("getUserMedia supported.");
  } else {
    alert(
      "Your browser does not support audio recording. Please use a modern browser like Chrome or Firefox."
    );
    if (startButton) startButton.disabled = true;
    return;
  }

  // Event listener for the "Start Recording" button
  if (startButton) {
    startButton.addEventListener("click", async () => {
      try {
        message.textContent = "Requesting microphone access...";
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
        });
        startButton.textContent = "🎙️Recording";  
        message.textContent = "Recording started... Ask me anything!";
        startButton.disabled = true;
        if (stopButton) stopButton.disabled = false;
        audioChunks = [];
        isConversationActive = true;

        mediaRecorder = new MediaRecorder(stream);

        mediaRecorder.ondataavailable = (event) => {
          audioChunks.push(event.data);
        };

        mediaRecorder.onstop = () => {
          message.textContent = "Recording stopped. Processing your question...";
          const audioBlob = new Blob(audioChunks, { type: "audio/mp3" });
          
          // Process audio through chat endpoint with session history
          processAudioWithChat(audioBlob);

          // Clean up the stream
          stream.getTracks().forEach((track) => track.stop());
        };

        mediaRecorder.start();
      } catch (err) {
        console.error("Error accessing microphone:", err);
        message.textContent =
          "Error: Could not access microphone. Please check your permissions.";
        startButton.disabled = false;
        if (stopButton) stopButton.disabled = true;
        isConversationActive = false;
      }
    });
  }

  // Event listener for the "Stop Recording" button
  if (stopButton) {
    stopButton.addEventListener("click", () => {
      if (mediaRecorder && mediaRecorder.state === "recording") {
        mediaRecorder.stop();
        if (startButton) startButton.disabled = false;
        stopButton.disabled = true;
        startButton.textContent = "🎙️Record";
        const stopButton = document.getElementById("stopButton");
        if (stopButton) stopButton.disabled = true;
      }
    });
  }

  // Setup auto-recording functionality
  setupAutoRecording();
});

// New function to process audio through conversational chat endpoint
async function processAudioWithChat(audioBlob) {
  const formData = new FormData();
  const filename = `recorded_audio.mp3`;
  const statusMessage = document.getElementById("status-message");
  const transcriptionDisplay = document.getElementById("transcription-display");
  const audioPlayback = document.getElementById("audio-player1");
  
  // Get current session ID
  const urlParams = new URLSearchParams(window.location.search);
  const sessionId = urlParams.get('session_id');
  
  formData.append("audio_file", audioBlob, filename);
  console.log("Processing audio with conversational chat for session:", sessionId);
  
  try {
    statusMessage.textContent = "🎧 Transcribing your question...";
    
    // Call the new chat endpoint with session ID
    const response = await fetch(`/agent/chat/${sessionId}`, {
      method: "POST",
      body: formData,
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.detail || "Failed to process audio");
    }
    
    const result = await response.json();
    console.log("Chat processing successful:", result);
    
    statusMessage.textContent = "🤖 Generating AI response...";
    
    // Display the conversation
    if (transcriptionDisplay) {
      // Append new conversation instead of replacing
      const conversationHtml = `
        <div style="margin-bottom: 15px; padding: 10px; background-color: rgba(127, 0, 255, 0.1); border-left: 3px solid #7F00FF; border-radius: 5px;">
          <strong style="color: #7F00FF;">You:</strong><br>
          "${result.user_message}"
        </div>
        <div style="margin-bottom: 20px; padding: 10px; background-color: rgba(0, 255, 127, 0.1); border-left: 3px solid #00FF7F; border-radius: 5px;">
          <strong style="color: #00FF7F;">AI:</strong><br>
          "${result.ai_response}"
        </div>
      `;
      
      if (transcriptionDisplay.innerHTML.trim() === "") {
        // First message in conversation
        transcriptionDisplay.innerHTML = `
          <div style="margin-bottom: 15px; text-align: center; color: #aaaaaa; font-size: 14px;">
            <strong>💬 Conversation History</strong>
          </div>
        ` + conversationHtml;
      } else {
        // Append to existing conversation
        transcriptionDisplay.innerHTML += conversationHtml;
      }
      
      transcriptionDisplay.style.display = "block";
      // Scroll to bottom of conversation
      transcriptionDisplay.scrollTop = transcriptionDisplay.scrollHeight;
    }
    
    statusMessage.textContent = "🔊 Playing AI response...";
    
    // Play the generated Murf audio response
    if (result.audio_url && audioPlayback) {
      audioPlayback.src = result.audio_url;
      audioPlayback.controls = true;
      audioPlayback.style.display = "block";
      
      // Auto-play the response
      try {
        await audioPlayback.play();
        statusMessage.textContent = `✅ Message ${result.message_count/2} complete! Continue the conversation...`;
      } catch (playError) {
        console.log("Auto-play prevented by browser:", playError);
        statusMessage.textContent = "✅ Response ready! Click play to hear the answer.";
      }
    } else {
      throw new Error("No audio URL received from server");
    }
    
  } catch (error) {
    console.error("Error in chat processing:", error);
    statusMessage.textContent = "❌ Processing failed: " + error.message;
    if (transcriptionDisplay) {
      const errorHtml = `
        <div style="color: #ff6b6b; padding: 10px; background-color: rgba(255, 107, 107, 0.1); border-left: 3px solid #ff6b6b; border-radius: 5px; margin-bottom: 15px;">
          <strong>Error:</strong> ${error.message}<br>
          Please try recording again.
        </div>
      `;
      transcriptionDisplay.innerHTML += errorHtml;
      transcriptionDisplay.style.display = "block";
    }
    
    // Reset conversation state on error
    const startButton = document.getElementById("recordButton");
    const stopButton = document.getElementById("stopButton");
    if (startButton) {
      startButton.disabled = false;
      startButton.textContent = "🎙️Record";
    }
    if (stopButton) {
      stopButton.disabled = true;
    }
  }
}

// Legacy function (keeping for reference but not used in conversational mode)
// New function to process audio through LLM pipeline
async function processAudioWithLLM(audioBlob) {
  const formData = new FormData();
  const filename = `recorded_audio.mp3`;
  const statusMessage = document.getElementById("status-message");
  const transcriptionDisplay = document.getElementById("transcription-display");
  const audioPlayback = document.getElementById("audio-player1");
  
  // Add conversation display elements
  const conversationSection = document.getElementById("conversation-section");
  const userMessageDiv = document.getElementById("user-message");
  const aiResponseDiv = document.getElementById("ai-response");
  
  formData.append("audio_file", audioBlob, filename);
  console.log("Processing audio with LLM...");
  
  try {
    statusMessage.textContent = "🎧 Transcribing your question...";
    
    // Call the updated LLM endpoint
    const response = await fetch("/llm/query", {
      method: "POST",
      body: formData,
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.detail || "Failed to process audio");
    }
    
    const result = await response.json();
    console.log("LLM processing successful:", result);
    
    statusMessage.textContent = "🤖 Generating AI response...";
    
    // Display the conversation
    if (transcriptionDisplay) {
      transcriptionDisplay.innerHTML = `
        <div style="margin-bottom: 15px;">
          <strong style="color: #7F00FF;">You said:</strong><br>
          "${result.user_message}"
        </div>
        <div>
          <strong style="color: #00FF7F;">AI Response:</strong><br>
          "${result.ai_response}"
        </div>
      `;
      transcriptionDisplay.style.display = "block";
    }
    
    statusMessage.textContent = "🔊 Playing AI response...";
    
    // Play the generated Murf audio response
    if (result.audio_url && audioPlayback) {
      audioPlayback.src = result.audio_url;
      audioPlayback.controls = true;
      audioPlayback.style.display = "block";
      
      // Auto-play the response
      try {
        await audioPlayback.play();
        statusMessage.textContent = "✅ Conversation complete! Ask another question.";
      } catch (playError) {
        console.log("Auto-play prevented by browser:", playError);
        statusMessage.textContent = "✅ Response ready! Click play to hear the answer.";
      }
    } else {
      throw new Error("No audio URL received from server");
    }
    
  } catch (error) {
    console.error("Error in LLM processing:", error);
    statusMessage.textContent = "❌ Processing failed: " + error.message;
    if (transcriptionDisplay) {
      transcriptionDisplay.innerHTML = `
        <div style="color: #ff6b6b;">
          <strong>Error:</strong> ${error.message}<br>
          Please try recording again.
        </div>
      `;
      transcriptionDisplay.style.display = "block";
    }
  }
}

// Legacy function (keeping for reference but not used)
// Updated function to process audio through TTS Echo
async function processAudioWithTTSEcho(audioBlob) {
  const formData = new FormData();
  const filename = `recorded_audio.mp3`;
  const statusMessage = document.getElementById("status-message");
  const transcriptionDisplay = document.getElementById("transcription-display");
  const audioPlayback = document.getElementById("audio-player1");
  
  formData.append("audio_file", audioBlob, filename);
  console.log("Processing audio with TTS Echo...");
  
  try {
    statusMessage.textContent = "Transcribing and generating voice...";
    
    // Call the TTS Echo endpoint
    const response = await fetch("/tts/echo", {
      method: "POST",
      body: formData,
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.detail || "Failed to process audio");
    }
    
    const result = await response.json();
    console.log("TTS Echo successful:", result);
    
    statusMessage.textContent = "Voice generation complete ✅";
    
    // Display the transcription
    if (transcriptionDisplay) {
      transcriptionDisplay.textContent = result.transcription || "No speech detected";
      transcriptionDisplay.style.display = "block";
    }
    
    // Play the generated Murf audio instead of the original recording
    if (result.audio_url && audioPlayback) {
      audioPlayback.src = result.audio_url;
      audioPlayback.controls = true;
      audioPlayback.style.display = "block";
      audioPlayback.play();
      statusMessage.textContent += " - Playing Murf voice";
    } else {
      throw new Error("No audio URL received from server");
    }
    
  } catch (error) {
    console.error("Error in TTS Echo:", error);
    statusMessage.textContent = "❌ Processing failed: " + error.message;
    if (transcriptionDisplay) {
      transcriptionDisplay.textContent = "Processing failed. Please try again.";
      transcriptionDisplay.style.display = "block";
    }
  }
}
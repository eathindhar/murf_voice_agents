// Enhanced voice assistant with Claude.ai-inspired UI and Cancel functionality
document.addEventListener("DOMContentLoaded", () => {
  // DOM Elements
  const recordButton = document.getElementById("recordButton");
  const cancelButton = document.getElementById("cancelButton");
  const statusMessage = document.getElementById("status-message");
  const audioPlayer = document.getElementById("audio-player");
  const welcomeScreen = document.getElementById("welcome-screen");
  const chatMessages = document.getElementById("chat-messages");
  const newSessionButton = document.getElementById("newSessionButton");
  const connectionDot = document.getElementById("connection-dot");
  const connectionStatus = document.getElementById("connection-status");
  
  // Session management
  let currentSessionId = getOrCreateSessionId();
  let isRecording = false;
  let isProcessing = false;
  let isPlayingAudio = false;
  let mediaRecorder;
  let audioChunks = [];
  let conversationCount = 0;
  let currentRequest = null; // For canceling ongoing requests

  // Initialize app
  initializeApp();

  function initializeApp() {
    updateConnectionStatus();
    performHealthCheck();
    setupEventListeners();
    setButtonState("idle");
  }

  function setupEventListeners() {
    // Record button
    recordButton.addEventListener("click", handleRecordButtonClick);
    
    // Cancel button
    cancelButton.addEventListener("click", handleCancelClick);
    
    // New session button
    newSessionButton.addEventListener("click", startNewSession);
    
    // Audio playback events
    audioPlayer.addEventListener("play", () => {
      isPlayingAudio = true;
      updateStatusMessage("Playing response... Click cancel to stop", "success");
      showCancelButton();
    });

    audioPlayer.addEventListener("ended", () => {
      isPlayingAudio = false;
      hideCancelButton();
      updateStatusMessage("Response complete! Click to record another message");
      setButtonState("idle");
    });

    audioPlayer.addEventListener("pause", () => {
      isPlayingAudio = false;
      hideCancelButton();
      updateStatusMessage("Audio stopped");
      setButtonState("idle");
    });
  }

  async function handleRecordButtonClick() {
    if (isProcessing || isPlayingAudio) {
      return;
    }

    if (!isRecording) {
      await startRecording();
    } else {
      stopRecording();
    }
  }

  function handleCancelClick() {
    if (isRecording) {
      cancelRecording();
    } else if (isProcessing) {
      cancelProcessing();
    } else if (isPlayingAudio) {
      cancelAudioPlayback();
    }
  }

  function cancelRecording() {
    try {
      if (mediaRecorder && mediaRecorder.state === "recording") {
        mediaRecorder.stop();
      }
      
      // Stop all tracks
      if (mediaRecorder && mediaRecorder.stream) {
        mediaRecorder.stream.getTracks().forEach(track => track.stop());
      }
      
      isRecording = false;
      hideCancelButton();
      updateStatusMessage("Recording cancelled");
      setButtonState("idle");
      
      showError("Recording cancelled by user", "warning");
      
    } catch (error) {
      console.error("Error cancelling recording:", error);
      resetToIdle();
    }
  }

  function cancelProcessing() {
    try {
      // Cancel any ongoing fetch request
      if (currentRequest) {
        currentRequest.abort();
        currentRequest = null;
      }
      
      isProcessing = false;
      hideCancelButton();
      updateStatusMessage("Processing cancelled");
      setButtonState("idle");
      
      showError("Processing cancelled by user", "warning");
      
    } catch (error) {
      console.error("Error cancelling processing:", error);
      resetToIdle();
    }
  }

  function cancelAudioPlayback() {
    try {
      if (audioPlayer && !audioPlayer.paused) {
        audioPlayer.pause();
        audioPlayer.currentTime = 0;
      }
      
      isPlayingAudio = false;
      hideCancelButton();
      updateStatusMessage("Audio playback stopped");
      setButtonState("idle");
      
    } catch (error) {
      console.error("Error cancelling audio playback:", error);
      resetToIdle();
    }
  }

  function showCancelButton() {
    cancelButton.style.display = "flex";
  }

  function hideCancelButton() {
    cancelButton.style.display = "none";
  }

  async function startRecording() {
    try {
      setButtonState("requesting");
      showCancelButton();
      updateStatusMessage("Requesting microphone access...");
      
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: 44100
        }
      });
      
      isRecording = true;
      setButtonState("recording");
      updateStatusMessage("Recording... Click to stop or cancel", "recording");
      
      // Hide welcome screen and show chat
      showChatInterface();
      
      audioChunks = [];
      
      mediaRecorder = new MediaRecorder(stream, {
        mimeType: MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/mp4'
      });

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunks.push(event.data);
        }
      };

      mediaRecorder.onstop = () => {
        stream.getTracks().forEach(track => track.stop());
        
        if (isRecording) {
          // Only process if not cancelled
          isRecording = false;
          processRecording();
        }
      };

      mediaRecorder.onerror = (event) => {
        console.error("MediaRecorder error:", event.error);
        showError("Recording failed. Please try again.");
        resetToIdle();
        stream.getTracks().forEach(track => track.stop());
      };

      mediaRecorder.start(1000);
      
    } catch (err) {
      console.error("Error accessing microphone:", err);
      isRecording = false;
      
      let errorMessage = "Failed to access microphone. ";
      if (err.name === 'NotAllowedError') {
        errorMessage += "Please allow microphone permissions and try again.";
      } else if (err.name === 'NotFoundError') {
        errorMessage += "No microphone found. Please connect a microphone.";
      } else {
        errorMessage += "Please check your device and try again.";
      }
      
      showError(errorMessage);
      resetToIdle();
    }
  }

  function stopRecording() {
    if (mediaRecorder && mediaRecorder.state === "recording") {
      mediaRecorder.stop();
      setButtonState("processing");
      updateStatusMessage("Processing your message... Click cancel to stop", "processing");
    }
  }

  async function processRecording() {
    try {
      isProcessing = true;
      setButtonState("processing");
      updateStatusMessage("Processing your message... Click cancel to stop", "processing");
      
      if (audioChunks.length === 0) {
        showError("No audio recorded. Please try again.");
        resetToIdle();
        return;
      }
      
      const audioBlob = new Blob(audioChunks, { 
        type: mediaRecorder.mimeType || 'audio/webm' 
      });
      
      if (audioBlob.size < 1000) {
        showError("Recording too short. Please speak longer and try again.");
        resetToIdle();
        return;
      }
      
      const formData = new FormData();
      const filename = `recording_${Date.now()}.webm`;
      formData.append("audio_file", audioBlob, filename);
      updateStatusMessage("Understanding your message... Click cancel to stop", "processing");
      
      // Create AbortController for cancellation
      const controller = new AbortController();
      currentRequest = controller;
      
      const response = await fetch(`/agent/chat/${currentSessionId}`, {
        method: "POST",
        body: formData,
        signal: controller.signal
      });
      
      // Clear the current request
      currentRequest = null;
      
      const result = await response.json();

      if (response.ok) { // Status 200
        handleSuccessfulResponse(result);
      } else if (response.status === 206) { // Partial success (text but no audio)
        handlePartialResponse(result);
      } else { // Error response
        handleErrorResponse(result);
      }
    } catch (error) {
      if (error.name === 'AbortError') {
        console.log("Request cancelled by user");
        return;
      }
      console.error("Error processing recording:", error);
      showError("Failed to process your message. Please try again.");
      resetToIdle();
    }
  }

  function handleSuccessfulResponse(result) {
    console.log("Successful response:", result);
    // Add messages to chat
    addUserMessage(result.user_message);
    addAssistantMessage(result.ai_response);
    
    // Update status and play audio
    updateStatusMessage("Playing response... Click cancel to stop", "success");
    if (result.audio_url) {
      audioPlayer.src = result.audio_url;
      audioPlayer.play().then(() => {
        conversationCount++;
        isProcessing = false;
        // Audio events will handle state updates
      }).catch(error => {
        console.error("Audio play error:", error);
        updateStatusMessage("Response ready! Audio couldn't auto-play.");
        resetToIdle();
      });
    } else {
      updateStatusMessage("Response complete!");
      resetToIdle();
    }
  }

  function handlePartialResponse(result) {
    console.log("Partial response:", result);
    // Add messages to chat
    addUserMessage(result.user_message);
    addAssistantMessage(result.ai_response);
    
    // Show warning about audio
    showError("Voice response unavailable, but here's the text answer.", "warning");
    
    if (result.audio_url) {
      audioPlayer.src = result.audio_url;
      audioPlayer.play().catch(e => console.log("Fallback audio failed:", e));
    }
    
    conversationCount++;
    updateStatusMessage("Response complete! Click to record another message");
    resetToIdle();
  }

  function handleErrorResponse(result) {
    console.error("Error response:", result);
    const errorMessage = result.fallback_message || result.error || "Something went wrong. Please try again.";
    showError(errorMessage);
    if (result.audio_url) {
      audioPlayer.src = result.audio_url;
      audioPlayer.play().catch(e => console.log("Error audio failed:", e));
    }
    resetToIdle();
  }

  function addUserMessage(text) {
    const messageDiv = document.createElement("div");
    messageDiv.className = "message user";
    messageDiv.innerHTML = `
      <div class="message-avatar">U</div>
      <div class="message-content">
        <div class="message-text">${escapeHtml(text)}</div>
        <div class="message-time">${formatTime(new Date())}</div>
      </div>
    `;
    chatMessages.appendChild(messageDiv);
    scrollToBottom();
  }

  function addAssistantMessage(text) {
    const messageDiv = document.createElement("div");
    messageDiv.className = "message assistant";
    messageDiv.innerHTML = `
      <div class="message-avatar">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M12 2L13.09 8.26L20 9L13.09 9.74L12 16L10.91 9.74L4 9L10.91 8.26L12 2Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
        </svg>
      </div>
      <div class="message-content">
        <div class="message-text">${escapeHtml(text)}</div>
        <div class="message-time">${formatTime(new Date())}</div>
      </div>
    `;
    chatMessages.appendChild(messageDiv);
    scrollToBottom();
  }

  function showChatInterface() {
    welcomeScreen.style.display = "none";
    chatMessages.style.display = "flex";
  }

  function startNewSession() {
    currentSessionId = getOrCreateSessionId(true);
    chatMessages.innerHTML = "";
    welcomeScreen.style.display = "flex";
    chatMessages.style.display = "none";
    conversationCount = 0;
    updateStatusMessage("Start a conversation by clicking the record button");
    resetToIdle();
    showSuccess("New chat session started!");
  }

  function getOrCreateSessionId(forceNew = false) {
    let sessionId = localStorage.getItem("voiceChatSessionId");
    if (!sessionId || forceNew) {
      sessionId = `session_${Date.now()}`;
      localStorage.setItem("voiceChatSessionId", sessionId);
    }
    return sessionId;
  }

  // UI State Management
  function setButtonState(state) {
    recordButton.dataset.state = state;
    const isIdle = state === "idle";
    const isRecording = state === "recording";
    const isProcessing = state === "processing" || state === "requesting";
    
    recordButton.disabled = !isIdle && !isRecording;
    
    // Manage icons
    const micIcon = document.querySelector("#mic-icon");
    const stopIcon = document.querySelector("#stop-icon");
    const loadingIcon = document.querySelector("#loading-icon");

    micIcon.style.display = isIdle ? 'block' : 'none';
    stopIcon.style.display = isRecording ? 'block' : 'none';
    loadingIcon.style.display = isProcessing ? 'block' : 'none';
    
    // Manage text
    document.getElementById("record-text").textContent = isRecording ? "Stop" : "Record";
  }

  function updateStatusMessage(message, type = "idle") {
    statusMessage.textContent = message;
    statusMessage.className = `status-message ${type}`;
  }

  function resetToIdle() {
    isRecording = false;
    isProcessing = false;
    isPlayingAudio = false;
    hideCancelButton();
    setButtonState("idle");
    updateStatusMessage("Click to record your message");
  }

  // Connection Health Check
  async function performHealthCheck() {
    try {
      const response = await fetch("/health");
      const data = await response.json();
      updateConnectionStatus(data.status);
    } catch (error) {
      console.error("Health check failed:", error);
      updateConnectionStatus("unhealthy");
    }
    setTimeout(performHealthCheck, 30000); // Check every 30 seconds
  }

  function updateConnectionStatus(status = "healthy") {
    if (status === "healthy") {
      connectionDot.className = "status-dot online";
      connectionStatus.textContent = "Connected";
    } else {
      connectionDot.className = "status-dot offline";
      connectionStatus.textContent = "Disconnected";
    }
  }

  // Toast Notifications
  function showToast(message, type = "success") {
    const toastId = type === "success" ? "success-toast" : "error-toast";
    const messageId = type === "success" ? "success-message" : "error-message";
    const toast = document.getElementById(toastId);
    const msgElement = document.getElementById(messageId);
    
    msgElement.textContent = message;
    toast.style.display = "flex";
    toast.classList.remove("hidden");
    
    setTimeout(() => {
      hideToast(type);
    }, 5000);
  }

  function showError(message, type = "error") {
    showToast(message, type);
  }
  
  function showSuccess(message) {
    showToast(message, "success");
  }

  function hideToast(type) {
    const toastId = type === "success" ? "success-toast" : "error-toast";
    const toast = document.getElementById(toastId);
    if (toast) {
      toast.classList.add("hidden");
      setTimeout(() => {
        toast.style.display = "none";
      }, 300);
    }
  }

  // Utility functions
  function scrollToBottom() {
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function formatTime(date) {
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    return `${hours}:${minutes}`;
  }

  function escapeHtml(text) {
    var map = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;'
    };
    return text.replace(/[&<>"']/g, function(m) { return map[m]; });
  }
});
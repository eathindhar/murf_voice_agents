// Enhanced voice assistant with Claude.ai-inspired UI and Cancel functionality
document.addEventListener("DOMContentLoaded", () => {
  // DOM Elements
  const recordButton = document.getElementById("recordButton");
  const cancelButton = document.getElementById("cancelButton");
  const recordText = document.getElementById("record-text");
  const statusMessage = document.getElementById("status-message");
  const audioPlayer = document.getElementById("audio-player");
  const welcomeScreen = document.getElementById("welcome-screen");
  const chatMessages = document.getElementById("chat-messages");
  const newSessionButton = document.getElementById("newSessionButton");
  const connectionDot = document.getElementById("connection-dot");
  const connectionStatus = document.getElementById("connection-status");
  
  // Icons
  const micIcon = document.getElementById("mic-icon");
  const stopIcon = document.getElementById("stop-icon");
  const loadingIcon = document.getElementById("loading-icon");

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
    
    // Toast dismiss buttons
    const dismissError = document.getElementById("dismiss-error");
    const dismissSuccess = document.getElementById("dismiss-success");
    
    if (dismissError) {
      dismissError.addEventListener("click", () => hideToast("error"));
    }
    
    if (dismissSuccess) {
      dismissSuccess.addEventListener("click", () => hideToast("success"));
    }

    // Auto-dismiss toasts
    document.addEventListener("click", (e) => {
      if (!e.target.closest(".toast")) {
        hideToast("error");
        hideToast("success");
      }
    });

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
      
      if (response.ok) {
        // Full success
        handleSuccessfulResponse(result);
      } else if (response.status === 206) {
        // Partial success (text but no audio)
        handlePartialResponse(result);
      } else {
        // Error response
        handleErrorResponse(result);
      }
      
    } catch (error) {
      if (error.name === 'AbortError') {
        // Request was cancelled
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
          <path d="M12 2L13.09 8.26L20 9L13.09 9.74L12 16L10.91 9.74L4 9L10.91 8.26L12 2Z"/>
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
    if (welcomeScreen.style.display !== "none") {
      welcomeScreen.style.display = "none";
      chatMessages.style.display = "flex";
    }
  }

  function setButtonState(state) {
    recordButton.setAttribute("data-state", state);
    
    // Hide all icons first
    micIcon.style.display = "none";
    stopIcon.style.display = "none";
    loadingIcon.style.display = "none";
    
    // Enable/disable button based on state
    recordButton.disabled = (state === "requesting" || state === "processing");
    
    switch (state) {
      case "idle":
        micIcon.style.display = "block";
        recordText.textContent = conversationCount > 0 ? "Click to speak" : "Click to start";
        break;
      case "requesting":
        loadingIcon.style.display = "block";
        recordText.textContent = "Requesting access...";
        break;
      case "recording":
        stopIcon.style.display = "block";
        recordText.textContent = "Click to stop";
        break;
      case "processing":
        loadingIcon.style.display = "block";
        recordText.textContent = "Processing...";
        break;
    }
  }

  function updateStatusMessage(message, type = "") {
    statusMessage.textContent = message;
    statusMessage.className = `status-message ${type}`;
  }

  function resetToIdle() {
    isRecording = false;
    isProcessing = false;
    isPlayingAudio = false;
    currentRequest = null;
    
    hideCancelButton();
    setButtonState("idle");
    updateStatusMessage(conversationCount > 0 ? "Ready for your next message" : "Click the button to start talking");
  }

  function showError(message, type = "error") {
    const toast = document.getElementById(`${type}-toast`);
    const messageElement = document.getElementById(`${type}-message`);
    
    if (toast && messageElement) {
      messageElement.textContent = message;
      toast.style.display = "flex";
      
      // Auto-hide after 5 seconds
      setTimeout(() => {
        hideToast(type);
      }, 5000);
    }
  }

  function showSuccess(message) {
    showError(message, "success");
  }

  function hideToast(type) {
    const toast = document.getElementById(`${type}-toast`);
    if (toast) {
      toast.style.display = "none";
    }
  }

  function scrollToBottom() {
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function formatTime(date) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function getOrCreateSessionId() {
    const urlParams = new URLSearchParams(window.location.search);
    let sessionId = urlParams.get('session_id');
    
    if (!sessionId) {
      sessionId = 'session_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
      urlParams.set('session_id', sessionId);
      window.history.replaceState({}, '', `${window.location.pathname}?${urlParams}`);
    }
    
    console.log('Current session ID:', sessionId);
    return sessionId;
  }

  function startNewSession() {
    // Cancel any ongoing operations first
    if (isRecording || isProcessing || isPlayingAudio) {
      handleCancelClick();
    }
    
    const newSessionId = 'session_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    const urlParams = new URLSearchParams(window.location.search);
    urlParams.set('session_id', newSessionId);
    window.history.replaceState({}, '', `${window.location.pathname}?${urlParams}`);
    currentSessionId = newSessionId;
    
    // Clear chat interface
    chatMessages.innerHTML = "";
    chatMessages.style.display = "none";
    welcomeScreen.style.display = "flex";
    
    // Reset conversation state
    conversationCount = 0;
    resetToIdle();
    
    console.log('Started new session:', currentSessionId);
    showSuccess("New conversation started!");
  }

  function updateConnectionStatus() {
    const isOnline = navigator.onLine;
    connectionDot.className = `status-dot ${isOnline ? 'online' : 'offline'}`;
    connectionStatus.textContent = isOnline ? 'Connected' : 'Offline';
  }

  async function performHealthCheck() {
    try {
      const response = await fetch("/health", {
        method: "GET",
        headers: { "Content-Type": "application/json" }
      });
      
      if (response.ok) {
        const healthData = await response.json();
        console.log("Health check result:", healthData);
        
        if (healthData.status === "healthy") {
          connectionDot.className = "status-dot online";
          connectionStatus.textContent = "Connected";
        } else if (healthData.status === "degraded") {
          connectionDot.className = "status-dot";
          connectionDot.style.backgroundColor = "#f59e0b";
          connectionStatus.textContent = "Limited";
        } else {
          connectionDot.className = "status-dot offline";
          connectionStatus.textContent = "Issues";
        }
      }
    } catch (error) {
      console.warn("Health check failed:", error);
      connectionDot.className = "status-dot offline";
      connectionStatus.textContent = "Unknown";
    }
  }

  // Network status monitoring
  window.addEventListener('online', () => {
    updateConnectionStatus();
    showSuccess("Connection restored!");
    performHealthCheck();
  });

  window.addEventListener('offline', () => {
    updateConnectionStatus();
    showError("You're offline. Please check your connection.", "warning");
  });

  // Global error handler
  window.addEventListener('error', (event) => {
    console.error('Global error caught:', event.error);
    showError("An unexpected error occurred. Please try again.");
    resetToIdle();
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    // Spacebar to start recording (only when idle)
    if (e.code === 'Space' && !e.target.matches('input, textarea, select')) {
      e.preventDefault();
      if (!isProcessing && !isRecording && !isPlayingAudio) {
        handleRecordButtonClick();
      }
    }
    
    // Escape to cancel any ongoing operation
    if (e.code === 'Escape') {
      handleCancelClick();
    }
    
    // Ctrl/Cmd + Enter for new session
    if ((e.ctrlKey || e.metaKey) && e.code === 'Enter') {
      e.preventDefault();
      startNewSession();
    }
  });

  // Prevent context menu on record button for better mobile experience
  recordButton.addEventListener('contextmenu', (e) => {
    e.preventDefault();
  });

  // Handle visibility change to pause recording if tab becomes hidden
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && (isRecording || isProcessing || isPlayingAudio)) {
      handleCancelClick();
      showError("Operation paused because the tab became inactive.", "warning");
    }
  });

  console.log("Voice Assistant initialized successfully");
});
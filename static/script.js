// Combined voice assistant with both standard and streaming modes
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
  const visualizerContainer = document.getElementById("visualizer-container");
  const visualizer = document.getElementById("visualizer");
  const streamIndicator = document.getElementById("stream-indicator");
  const streamingStatusText = document.getElementById("streaming-status-text");
  const streamingControls = document.getElementById("streaming-controls");

  // Mode selection
  const modeOptions = document.querySelectorAll(".mode-option");
  let currentMode = "standard"; // 'standard' or 'streaming'

  // Session management
  let currentSessionId = getOrCreateSessionId();
  let isRecording = false;
  let isProcessing = false;
  let isPlayingAudio = false;
  let mediaRecorder;
  let audioChunks = [];
  let conversationCount = 0;
  let currentRequest = null;

  // Streaming mode variables
  let streamingWs = null;
  let audioContext = null;
  let analyser = null;
  let microphone = null;
  let visualizerInterval = null;
  let audioStream = null;

  // Initialize app
  initializeApp();

  function initializeApp() {
    updateConnectionStatus();
    performHealthCheck();
    setupEventListeners();
    setButtonState("idle");
    updateModeUI();
  }

  function setupEventListeners() {
    // Mode selection
    modeOptions.forEach((option) => {
      option.addEventListener("click", () => switchMode(option.dataset.mode));
    });

    // Record button
    recordButton.addEventListener("click", handleRecordButtonClick);

    // Cancel button
    cancelButton.addEventListener("click", handleCancelClick);

    // New session button
    newSessionButton.addEventListener("click", startNewSession);

    // Audio playback events
    audioPlayer.addEventListener("play", () => {
      isPlayingAudio = true;
      updateStatusMessage(
        "Playing response... Click cancel to stop",
        "success"
      );
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

  function switchMode(mode) {
    currentMode = mode;

    // Update UI
    modeOptions.forEach((option) => {
      option.classList.toggle("active", option.dataset.mode === mode);
    });

    updateModeUI();

    if (isRecording) {
      handleCancelClick(); // Stop any ongoing recording when switching modes
    }

    if (mode === "streaming") {
      initializeStreamingMode();
    } else {
      cleanupStreamingMode();
    }
  }

  function updateModeUI() {
    if (currentMode === "streaming") {
      visualizerContainer.style.display = "block";
      streamingControls.style.display = "flex";
      updateStatusMessage(
        "Streaming mode active - Click to start real-time recording"
      );
    } else {
      visualizerContainer.style.display = "none";
      streamingControls.style.display = "none";
      updateStatusMessage("Standard mode - Click to record your message");
    }
  }

  // Streaming mode functions
  async function initializeStreamingMode() {
    if (!streamingWs || streamingWs.readyState === WebSocket.CLOSED) {
      try {
        const wsUrl = `ws://localhost:8000/ws/audio/${currentSessionId}`;
        streamingWs = new WebSocket(wsUrl);

        streamingWs.onopen = () => {
          streamIndicator.className = "stream-indicator";
          streamingStatusText.textContent = "Streaming connection active";
          showSuccess("Streaming mode connected");
        };

        streamingWs.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            handleStreamingMessage(data);
          } catch (e) {
            console.log(`Non-JSON streaming message: ${event.data}`);
          }
        };

        streamingWs.onclose = () => {
          streamIndicator.className = "stream-indicator inactive";
          streamingStatusText.textContent = "Streaming connection lost";
        };

        streamingWs.onerror = (error) => {
          showError("Streaming connection error");
          streamIndicator.className = "stream-indicator inactive";
          streamingStatusText.textContent = "Streaming connection failed";
        };
      } catch (error) {
        showError(`Failed to connect streaming: ${error.message}`);
      }
    }
  }

  function cleanupStreamingMode() {
    if (streamingWs) {
      streamingWs.close();
      streamingWs = null;
    }
    cleanupAudioVisualization();
    streamIndicator.className = "stream-indicator inactive";
    streamingStatusText.textContent = "Streaming inactive";
  }

  function handleStreamingMessage(data) {
    console.log("Streaming message:", data);

    switch (data.type) {
      case "connection_established":
        showSuccess("Streaming ready for recording");
        break;
      case "recording_started":
        showSuccess(`Streaming recording started: ${data.filename}`);
        break;
      case "recording_stopped":
        showSuccess(
          `Recording saved: ${data.filename} (${data.chunk_count} chunks, ${(
            data.total_bytes / 1024
          ).toFixed(1)}KB)`
        );
        break;
      case "error":
        showError(`Streaming error: ${data.message}`);
        break;
    }
  }

  function sendStreamingMessage(data) {
    if (streamingWs && streamingWs.readyState === WebSocket.OPEN) {
      streamingWs.send(JSON.stringify(data));
    }
  }

  // Recording functions (adapted for both modes)
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

  async function startRecording() {
    try {
      setButtonState("requesting");
      showCancelButton();
      updateStatusMessage("Requesting microphone access...");

      audioStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: 44100,
        },
      });

      isRecording = true;
      setButtonState("recording");

      // Show chat interface
      showChatInterface();

      if (currentMode === "streaming") {
        await startStreamingRecording();
      } else {
        await startStandardRecording();
      }
    } catch (err) {
      console.error("Error accessing microphone:", err);
      handleMicrophoneError(err);
    }
  }

  async function startStreamingRecording() {
    updateStatusMessage(
      "Streaming audio in real-time... Click to stop",
      "recording"
    );

    // Setup audio visualization
    setupAudioVisualization();

    // Send start command to server
    sendStreamingMessage({
      type: "start_recording",
      session_id: currentSessionId,
      timestamp: new Date().toISOString(),
    });

    // Setup MediaRecorder for streaming
    mediaRecorder = new MediaRecorder(audioStream, {
      mimeType: "audio/webm;codecs=opus",
      audioBitsPerSecond: 128000,
    });

    mediaRecorder.ondataavailable = (event) => {
      if (
        event.data.size > 0 &&
        streamingWs &&
        streamingWs.readyState === WebSocket.OPEN
      ) {
        // Send binary audio data directly via WebSocket
        streamingWs.send(event.data);
      }
    };

    // Start recording with small time slices for real-time streaming
    mediaRecorder.start(250); // Send chunk every 250ms
  }

  async function startStandardRecording() {
    updateStatusMessage("Recording... Click to stop", "recording");

    audioChunks = [];

    mediaRecorder = new MediaRecorder(audioStream, {
      mimeType: MediaRecorder.isTypeSupported("audio/webm")
        ? "audio/webm"
        : "audio/mp4",
    });

    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        audioChunks.push(event.data);
      }
    };

    mediaRecorder.onstop = () => {
      audioStream.getTracks().forEach((track) => track.stop());

      if (isRecording) {
        // Only process if not cancelled
        isRecording = false;
        processStandardRecording();
      }
    };

    mediaRecorder.start(1000);
  }

  function stopRecording() {
    if (mediaRecorder && mediaRecorder.state === "recording") {
      mediaRecorder.stop();
    }

    if (currentMode === "streaming") {
      stopStreamingRecording();
    } else {
      setButtonState("processing");
      updateStatusMessage(
        "Processing your message... Click cancel to stop",
        "processing"
      );
    }
  }

  function stopStreamingRecording() {
    // Send stop command to server
    sendStreamingMessage({
      type: "stop_recording",
      session_id: currentSessionId,
      timestamp: new Date().toISOString(),
    });

    // Clean up
    cleanupAudioVisualization();
    if (audioStream) {
      audioStream.getTracks().forEach((track) => track.stop());
    }

    isRecording = false;
    setButtonState("idle");
    hideCancelButton();
    updateStatusMessage("Streaming recording complete!");

    showSuccess("Audio streamed and saved to server!");
  }

  // Audio visualization
  function setupAudioVisualization() {
    try {
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
      analyser = audioContext.createAnalyser();
      microphone = audioContext.createMediaStreamSource(audioStream);

      analyser.fftSize = 256;
      microphone.connect(analyser);

      // Create visualizer bars
      visualizer.innerHTML = "";
      const barCount = 32;

      for (let i = 0; i < barCount; i++) {
        const bar = document.createElement("div");
        bar.className = "visualizer-bar";
        bar.style.height = "4px";
        visualizer.appendChild(bar);
      }

      startVisualization();
    } catch (error) {
      console.error("Audio visualization setup failed:", error);
    }
  }

  function startVisualization() {
    const bars = visualizer.querySelectorAll(".visualizer-bar");
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    const updateBars = () => {
      if (!isRecording || currentMode !== "streaming") return;

      analyser.getByteFrequencyData(dataArray);

      bars.forEach((bar, index) => {
        const dataIndex = Math.floor((index / bars.length) * bufferLength);
        const value = dataArray[dataIndex] || 0;
        const height = Math.max(4, (value / 255) * 50);
        bar.style.height = `${height}px`;
      });
    };

    visualizerInterval = setInterval(updateBars, 50); // Update 20 times per second
  }

  function cleanupAudioVisualization() {
    if (visualizerInterval) {
      clearInterval(visualizerInterval);
      visualizerInterval = null;
    }

    if (audioContext) {
      audioContext.close();
      audioContext = null;
    }
    analyser = null;
    microphone = null;

    // Reset visualizer
    visualizer.innerHTML =
      '<div style="color: #888; font-size: 14px;">Audio Visualizer</div>';
  }

  // Standard recording processing (existing functionality)
  async function processStandardRecording() {
    try {
      isProcessing = true;
      setButtonState("processing");
      updateStatusMessage(
        "Processing your message... Click cancel to stop",
        "processing"
      );

      if (audioChunks.length === 0) {
        showError("No audio recorded. Please try again.");
        resetToIdle();
        return;
      }

      const audioBlob = new Blob(audioChunks, {
        type: mediaRecorder.mimeType || "audio/webm",
      });

      if (audioBlob.size < 1000) {
        showError("Recording too short. Please speak longer and try again.");
        resetToIdle();
        return;
      }

      const formData = new FormData();
      const filename = `recording_${Date.now()}.webm`;
      formData.append("audio_file", audioBlob, filename);
      updateStatusMessage(
        "Understanding your message... Click cancel to stop",
        "processing"
      );

      // Create AbortController for cancellation
      const controller = new AbortController();
      currentRequest = controller;

      const response = await fetch(`/agent/chat/${currentSessionId}`, {
        method: "POST",
        body: formData,
        signal: controller.signal,
      });

      // Clear the current request
      currentRequest = null;

      const result = await response.json();

      if (response.ok) {
        handleSuccessfulResponse(result);
      } else if (response.status === 206) {
        handlePartialResponse(result);
      } else {
        handleErrorResponse(result);
      }
    } catch (error) {
      if (error.name === "AbortError") {
        console.log("Request cancelled by user");
        return;
      }
      console.error("Error processing recording:", error);
      showError("Failed to process your message. Please try again.");
      resetToIdle();
    }
  }

  // Response handlers (existing)
  function handleSuccessfulResponse(result) {
    console.log("Successful response:", result);
    addUserMessage(result.user_message);
    addAssistantMessage(result.ai_response);

    updateStatusMessage("Playing response... Click cancel to stop", "success");
    if (result.audio_url) {
      audioPlayer.src = result.audio_url;
      audioPlayer
        .play()
        .then(() => {
          conversationCount++;
          isProcessing = false;
        })
        .catch((error) => {
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
    addUserMessage(result.user_message);
    addAssistantMessage(result.ai_response);

    showError(
      "Voice response unavailable, but here's the text answer.",
      "warning"
    );

    if (result.audio_url) {
      audioPlayer.src = result.audio_url;
      audioPlayer.play().catch((e) => console.log("Fallback audio failed:", e));
    }

    conversationCount++;
    updateStatusMessage("Response complete! Click to record another message");
    resetToIdle();
  }

  function handleErrorResponse(result) {
    console.error("Error response:", result);
    const errorMessage =
      result.fallback_message ||
      result.error ||
      "Something went wrong. Please try again.";
    showError(errorMessage);
    if (result.audio_url) {
      audioPlayer.src = result.audio_url;
      audioPlayer.play().catch((e) => console.log("Error audio failed:", e));
    }
    resetToIdle();
  }

  // Cancel functions
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

      if (audioStream) {
        audioStream.getTracks().forEach((track) => track.stop());
      }

      if (currentMode === "streaming") {
        cleanupAudioVisualization();
        sendStreamingMessage({
          type: "stop_recording",
          session_id: currentSessionId,
          timestamp: new Date().toISOString(),
        });
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

  // UI helper functions
  function showCancelButton() {
    cancelButton.style.display = "flex";
  }

  function hideCancelButton() {
    cancelButton.style.display = "none";
  }

  function handleMicrophoneError(err) {
    isRecording = false;

    let errorMessage = "Failed to access microphone. ";
    if (err.name === "NotAllowedError") {
      errorMessage += "Please allow microphone permissions and try again.";
    } else if (err.name === "NotFoundError") {
      errorMessage += "No microphone found. Please connect a microphone.";
    } else {
      errorMessage += "Please check your device and try again.";
    }

    showError(errorMessage);
    resetToIdle();
  }

  // Chat UI functions (existing)
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
    updateStatusMessage(
      currentMode === "streaming"
        ? "Streaming mode active - Click to start real-time recording"
        : "Standard mode - Click to record your message"
    );
    resetToIdle();

    // Reinitialize streaming if in streaming mode
    if (currentMode === "streaming") {
      cleanupStreamingMode();
      initializeStreamingMode();
    }

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

  // UI State Management (existing)
  function setButtonState(state) {
    recordButton.dataset.state = state;
    const isIdle = state === "idle";
    const isRecording = state === "recording";
    const isProcessing = state === "processing" || state === "requesting";

    recordButton.disabled = !isIdle && !isRecording;

    const micIcon = document.querySelector("#mic-icon");
    const stopIcon = document.querySelector("#stop-icon");
    const loadingIcon = document.querySelector("#loading-icon");

    micIcon.style.display = isIdle ? "block" : "none";
    stopIcon.style.display = isRecording ? "block" : "none";
    loadingIcon.style.display = isProcessing ? "block" : "none";

    document.getElementById("record-text").textContent = isRecording
      ? "Stop"
      : "Record";
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
    cleanupAudioVisualization();

    if (audioStream) {
      audioStream.getTracks().forEach((track) => track.stop());
      audioStream = null;
    }

    updateStatusMessage(
      currentMode === "streaming"
        ? "Streaming mode - Click to start recording"
        : "Click to record your message"
    );
  }

  // Connection health check (existing)
  async function performHealthCheck() {
    try {
      const response = await fetch("/health");
      const data = await response.json();
      updateConnectionStatus(data.status);
    } catch (error) {
      console.error("Health check failed:", error);
      updateConnectionStatus("unhealthy");
    }
    setTimeout(performHealthCheck, 30000);
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

  // Toast notifications (existing)
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

  // Utility functions (existing)
  function scrollToBottom() {
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function formatTime(date) {
    const hours = date.getHours().toString().padStart(2, "0");
    const minutes = date.getMinutes().toString().padStart(2, "0");
    return `${hours}:${minutes}`;
  }

  function escapeHtml(text) {
    var map = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;",
    };
    return text.replace(/[&<>"']/g, function (m) {
      return map[m];
    });
  }

  // Cleanup on page unload
  window.addEventListener("beforeunload", () => {
    cleanupStreamingMode();
    if (audioStream) {
      audioStream.getTracks().forEach((track) => track.stop());
    }
  });
});

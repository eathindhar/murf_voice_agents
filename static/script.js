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
  const audioPlayback = document.getElementById("audio-player1"); // Assuming a separate player for recorded audio
  const message = document.getElementById("message");

  let mediaRecorder;
  let audioChunks = [];

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

  // --- NEW Audio Recording Logic ---

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
        message.textContent = "Recording started...";
        startButton.disabled = true;
        if (stopButton) stopButton.disabled = false;
        audioChunks = [];

        mediaRecorder = new MediaRecorder(stream);

        mediaRecorder.ondataavailable = (event) => {
          audioChunks.push(event.data);
        };

        mediaRecorder.onstop = () => {
          message.textContent = "Recording stopped. Preparing audio...";
          const audioBlob = new Blob(audioChunks, { type: "audio/mp4" });
          const audioUrl = URL.createObjectURL(audioBlob);
          uploadAudio(audioBlob); // Call the upload function
          console.log("Audio recorded and uploaded:", audioUrl);
          audioPlayback.src = audioUrl;
          audioPlayback.controls = true;
          audioPlayback.style.display = "block";
          audioPlayback.play();
          message.textContent = "Playback ready.";

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
      }
    });
  }
});

// A new function to upload the audio to the server
async function uploadAudio(audioBlob) {
  const formData = new FormData();

  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  timestamp = ` audio_${year}${month}${day}_${hours}${minutes}${seconds}.mp4`;
  console.log("Timestamp for audio file:", timestamp);
  const statusMessage = document.getElementById("status-message");
  formData.append("audio_file", audioBlob, timestamp); // "audio_file" is the field name the server expects
  console.log("Uploading audio file...");
  try {
    // You'll need to create this /upload-audio endpoint in your FastAPI code
    const response = await fetch("/upload-audio", {
      method: "POST",
      body: formData,
    });

    if (!response.ok) {
      throw new Error("Failed to upload audio.");
    }
    const result = await response.json();
    console.log("Upload successful:", result);
    statusMessage.textContent = "Uploaded ✅ File name: " + result.file_name;
    // You can now display the file info (name, size, etc.) to the user
  } catch (error) {
    console.error("Error uploading audio:", error);
    // Handle the error gracefully, e.g., show a message to the user
  }
}

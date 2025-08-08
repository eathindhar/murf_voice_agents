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
  const audioPlayback = document.getElementById("audio-player1"); // Echo bot audio player
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
          message.textContent = "Recording stopped. Processing...";
          const audioBlob = new Blob(audioChunks, { type: "audio/mp3" });
          
          // Instead of playing the recorded audio, process it through TTS Echo
          processAudioWithTTSEcho(audioBlob);

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
    
    // Call the new TTS Echo endpoint
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

// Legacy function (keeping for reference but not used)
// async function uploadAndTranscribeAudio(audioBlob) {
//   const formData = new FormData();
//   const filename = `recorded_audio.mp3`;
//   const statusMessage = document.getElementById("status-message");
//   const transcriptionDisplay = document.getElementById("transcription-display");
  
//   formData.append("audio_file", audioBlob, filename);
//   console.log("Transcribing audio file...");
  
//   try {
//     statusMessage.textContent = "Transcribing audio...";
    
//     const response = await fetch("/transcribe/file", {
//       method: "POST",
//       body: formData,
//     });

//     if (!response.ok) {
//       throw new Error("Failed to transcribe audio.");
//     }
    
//     const result = await response.json();
//     console.log("Transcription successful:", result);
    
//     statusMessage.textContent = "Transcription complete ✅";
    
//     // Display the transcription
//     if (transcriptionDisplay) {
//       transcriptionDisplay.textContent = result.transcription || "No speech detected";
//       transcriptionDisplay.style.display = "block";
//     }
    
//   } catch (error) {
//     console.error("Error transcribing audio:", error);
//     statusMessage.textContent = "❌ Transcription failed: " + error.message;
//     if (transcriptionDisplay) {
//       transcriptionDisplay.textContent = "Transcription failed. Please try again.";
//       transcriptionDisplay.style.display = "block";
//     }
//   }
// }
// When the button is clicked, change the heading and show a thank-you message
document.addEventListener("DOMContentLoaded", () => {
    const button = document.getElementById("cta-btn");
    const input = document.getElementById("text-input");
    const audioPlayer = document.getElementById("audio-player");
    const loader = document.getElementById("loader");
    const btnText = document.getElementById("btn-text");
    let selectedVoice = "en-US-natalie";

    // Voice selection
    const voiceButtons = document.querySelectorAll(".voice-btn");
    voiceButtons.forEach(btn => {
        btn.addEventListener("click", () => {
            voiceButtons.forEach(b => b.classList.remove("selected"));
            btn.classList.add("selected");
            selectedVoice = btn.getAttribute("data-voice");
            console.log("Selected voice:", selectedVoice);
        });
    });


    button.addEventListener("click", async () => {
        const text = input.value.trim();
        if(!text){
            alert("Please enter some text to generate audio.");
            return;
        }

        // Show loader
        loader.style.display = "inline-block";
        btnText.textContent = "Generating...";
        button.disabled = true;

        try {
            const response = await fetch("/generate-audio",{
                method:"POST",
                headers: {
                "content-type": "application/json"
                },
                body: JSON.stringify({ text: text, voice_id: selectedVoice })
            });
            console.log({
                method:"POST",
                headers: {
                "content-type": "application/json"
                },
                body: JSON.stringify({ text: text, voice_id: selectedVoice })
            });
            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.detail || "Failed to generate audio.");
            }
            const data = await response.json();
            audioPlayer.src = data.audio_url;
            audioPlayer.style.display = "block";
            audioPlayer.play();
            }
        catch (error) {
            console.error("Error generating audio:", error);
            alert("An error occurred while generating audio: " + error.message);
        }
        finally {
            // ✅ Always stop loader, re-enable button
            loader.style.display = "none";
            btnText.textContent = "Generate Audio";
            button.disabled = false;
        }
    });
});
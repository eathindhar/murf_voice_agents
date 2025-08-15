# Murf Voice Agents

This project was developed as part of the Murf AI's 30 Days of Voice Agents Challenge. It is a web-based application that utilizes multiple APIs to create interactive voice agents, capable of transcribing speech, processing user queries with a large language model, and generating voice responses.

---

## 🌟 Features

* **Voice Agent Generation:** Create dynamic voice agents using the Murf AI platform.

* **Real-time Transcription:** Use AssemblyAI to transcribe spoken audio into text in real-time.

* **Intelligent Conversational AI:** Process transcribed text and generate intelligent responses using the Gemini API.

* **Web Interface:** The project provides a user-friendly web interface for interacting with the voice agents.

* **Error Simulation:** The inclusion of an `error_simulation.py` file suggests a feature for testing and handling potential errors within the voice agent's functionality.

---

## 💻 Technologies Used

This project is built primarily with Python, and it utilizes standard web technologies for the user interface.

* **Backend:**

    * **Python:** The core programming language for the server-side logic.

    * **FastAPI:** A modern, fast (high-performance) web framework for building APIs with Python 3.7+.

* **Frontend:**

    * **HTML, CSS, JavaScript:** Standard web technologies used to build the user interface and handle client-side interactions.

* **APIs:**

    * **Murf AI API:** The project interacts with Murf AI's API for generating and managing voice agents.

    * **AssemblyAI:** Used for real-time speech-to-text transcription.

    * **Gemini API:** Utilized as a large language model to process user queries and generate responses.

---

## 🏗️ Architecture

The project follows a **Client-Server Architecture**.

* The **Client-side** is a standard web application composed of HTML, CSS, and JavaScript. It provides the user interface and sends audio data to the Python backend.

* The **Server-side** is a web server written in Python using FastAPI. It acts as an intermediary, handling the following workflow:

    1. Receives audio data from the client.

    2. Sends the audio data to **AssemblyAI** for transcription.

    3. Sends the transcribed text to the **Gemini API** for an LLM response.

    4. Sends the LLM's text response to the **Murf AI API** to generate a voice response.

    5. Sends the final voice response back to the client.

---

## 🚀 Getting Started

Follow these instructions to set up and run the project on your local machine.

### Prerequisites

Make sure you have the following installed:

* **Python 3:** The programming language used for the backend.

* **pip:** The package installer for Python (usually comes with Python).

### Installation

1. Clone the repository:

git clone https://your-repo-link.git
cd murf_voice_agents


2. Install the required Python dependencies listed in the `requirements.txt` file:

pip install -r requirements.txt


### Environment Variables

You need to create a `.env` file in the root of the project and set the API keys for all three services. You can use the `.env.example` file as a template.

.env file
MURF_API_KEY="your_murf_ai_api_key_here"
ASSEMBLYAI_API_KEY="your_assemblyai_api_key_here"
GEMINI_API_KEY="your_gemini_api_key_here"


### Running the Project

1. Run the main FastAPI application from the root of the project. The default port is **8000**.

uvicorn main:app --reload --port 8000


2. The application will start, and you can access it in your web browser at `http://localhost:8000`.

---

## 📸 Screenshots

![KathAI Screenshot](screenshots\screenshot_v1.png)
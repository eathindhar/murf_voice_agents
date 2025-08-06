import os
import shutil
import requests
from dotenv import load_dotenv
from fastapi import FastAPI, Request, HTTPException, UploadFile, File
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel
from pathlib import Path
from datetime import datetime

# Load environment variables from .env file
load_dotenv()
api_key = os.getenv("API_KEY")

# Initialize FastAPI app
app = FastAPI()

# Mount static files directory
app.mount("/static", StaticFiles(directory="static"), name="static")

# Initialize Jinja2 templates
templates = Jinja2Templates(directory="templates")

# Define a Pydantic model for request body
class TTSRequest(BaseModel):
    text: str = "The quick brown fox jumps over the lazy dog"
    voice_id: str = "en-US-natalie"  # Default voice ID, can be changed as needed

# Define the upload folder
UPLOAD_FOLDER = "uploads"
os.makedirs(UPLOAD_FOLDER, exist_ok=True)

# Define routes
@app.get("/", response_class=HTMLResponse)
async def read_root(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})
    
@app.post("/generate-audio", response_class=JSONResponse)
async def generate_audio(request: TTSRequest):
    try:
        url = "https://api.murf.ai/v1/speech/generate"
        payload = {
            "text": request.text,
            "voice_id": request.voice_id
        }

        header= {
            "content-type": "application/json",
            "api-key": api_key
        }   

        response = requests.post(url, json=payload, headers=header)
        #print("Murf API Response: ", response.status_code, response.json())
        
        if response.status_code == 200:
            audio_url = response.json().get("audioFile")
            if audio_url:
                return {"audio_url": audio_url}
            else:
                raise HTTPException(status_code=500, detail="Audio URL not found in response.")

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    
@app.post("/upload-audio", response_class=JSONResponse)
async def upload_audio(audio_file:UploadFile=File(...)):
    timestamp = datetime.now().strftime("%Y%m%d%H%M%S")
    print("Received audio file:", audio_file.filename)
    file_extention = Path(audio_file.filename).suffix
    print("File extension:", file_extention)
    file_name = f"recorded_audio_{timestamp}{file_extention}"
    print("Generated file name:", file_name)
    file_location = Path(UPLOAD_FOLDER) / file_name
    print("Saving audio file to:", file_location)

    try:
        # Save the uploaded audio file to a temporary location
        with open(file_location, "wb") as f:
            shutil.copyfileobj(audio_file.file, f)
        return {
            "file_name": audio_file.filename,
            "content_type": audio_file.content_type,
            "file_size":os.path.getsize(file_location),
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
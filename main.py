from fastapi import FastAPI

api = FastAPI()

# defining methods for the API - GET, POST, PUT, DELETE
@api.get("/")
def index():
    return {"message": "Welcome to Murf AI's 30 Days of Voice Agents Challenge!"}
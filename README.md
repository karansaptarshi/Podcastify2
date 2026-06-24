# Podcastly

Listen to any book as a podcast conversation.

 Note: The backend may have a cold-start delay because I need to renew it. If generation fails the first time, try generating it again.
 
For the easiest experience, go to [podcastify2.pages.dev](https://podcastify2.pages.dev).

## What It Does

- Searches for a readable book PDF or accepts a direct PDF link.
- Extracts and chunks book text for long-form generation.
- Generates podcast dialogue and renders playable audio clips.
- Stores generated assets through the configured backend storage.

## Local Development

Frontend:

```bash
cd frontend
npm install
npm run dev
```

Backend:

```bash
cd backend
pip install -r requirements.txt
uvicorn main:app --reload --port 8001
```

The frontend defaults to the deployed Railway backend. Set `VITE_API_URL` if you want it to talk to a local backend.

Backend credentials and provider settings live in `backend/.env`.

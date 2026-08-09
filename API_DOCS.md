# Video Queue API Documentation

This Cloudflare Worker now provides a REST API to manage the social media video publishing queue. 

## Base URL
Use your worker's deployed URL (e.g. `https://ftn-worker.evorsio1.workers.dev`).

## Authentication
Every request to the API must include your API key. You must configure this in your worker by running:
`npx wrangler secret put API_KEY`

Pass the API key in the headers of your HTTP request using either:
- `x-api-key: YOUR_API_KEY`
- `Authorization: Bearer YOUR_API_KEY`

---

## 1. Webhook (Create Video)
`POST /api/webhook` (or `POST /` for backwards compatibility)

Adds a new video to the queue.

**Request Body (JSON):**
```json
{
  "brand": "FTN News", 
  "title": "Are NYC's rat problems finally ending?",
  "download_url": "https://bucket.euno.cc/clips/.../clip_1.mp4",
  "scheduled_date": "2026-08-10T10:00:00.000Z",
  "timezone": "Europe/Berlin"
}
```

---

## 2. List All Videos
`GET /api/videos`

Retrieves a list of all videos currently in the queue, along with their calculated statuses.

**Response:**
```json
[
  {
    "id": "123e4567-e89b-12d3-a456-426614174000",
    "brand": "FTN News",
    "title": "Are NYC's rat problems finally ending?",
    "download_url": "https://...",
    "scheduled_date": "2026-08-10T10:00:00.000Z",
    "status": "scheduled",
    "completed_channels": []
  }
]
```

### Possible Statuses:
- **`scheduled`**: Video is waiting for its scheduled time.
- **`waiting on missing IDs`**: The time has come, but some channels in `index.js` still have `BUFFER_` placeholders. The worker is holding the video until you provide the real IDs.
- **`partially posted`**: The video was successfully pushed to some channels, but not all of them.
- **`failed/retrying`**: The video failed to post to Buffer (API error). The worker will retry every 5 minutes.
*(Note: Videos that have successfully posted to all channels are automatically deleted and will not appear in this list).*

---

## 3. Update a Scheduled Video
`PATCH /api/videos/:id`

Updates the properties of a scheduled video. Useful for rescheduling.

**Request Body (JSON):**
```json
{
  "scheduled_date": "2026-10-15T15:00:00.000Z"
}
```

---

## 4. Post Now (Fast-Track)
`POST /api/videos/:id/post-now`

Forces the video to be published immediately by changing its `scheduled_date` to the current time. It will be picked up by the next cron run (within a maximum of 5 minutes).

---

## 5. Delete a Video
`DELETE /api/videos/:id`

Removes a video from the queue entirely. It will not be posted.

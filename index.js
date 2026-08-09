const BRAND_CONFIG = {
  "FTN News": [
    "6a78a0bcb2d9d5774345aec9",    // TikTok
    "6a789f17b2d9d5774345a91d", // Instagram
    "BUFFER_FTN_NEWS_YOUTUBE_ID"    // YouTube
  ],
  "FTN Sports": [
    "6a78b789b2d9d5774346584f",    // TikTok
    "6a78b7c7b2d9d5774346590b", // Instagram
    "BUFFER_FTN_SPORTS_YOUTUBE_ID"    // YouTube
  ]
};

export default {
  async fetch(request, env, ctx) {
    // Basic API Key Authentication
    const apiKey = request.headers.get("x-api-key") || request.headers.get("Authorization")?.replace("Bearer ", "");
    if (apiKey !== env.API_KEY) {
      return new Response("Unauthorized", { status: 401 });
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    try {
      // 1. Webhook (backward compatible with root `/` for ease of transition)
      if (method === "POST" && (path === "/api/webhook" || path === "/")) {
        const body = await request.json();
        if (!body.brand || !body.title || !body.download_url || !body.scheduled_date) {
          return new Response(JSON.stringify({ error: "Missing required fields" }), { status: 400, headers: { "Content-Type": "application/json" } });
        }
        const jobId = crypto.randomUUID();
        await env.QUEUE_STORE.put(jobId, JSON.stringify(body));
        return new Response(JSON.stringify({ success: true, jobId }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      // 2. GET all videos
      if (method === "GET" && path === "/api/videos") {
        let keys = [];
        let listComplete = false;
        let cursor = undefined;
        while (!listComplete) {
          const listResult = await env.QUEUE_STORE.list({ cursor });
          keys.push(...listResult.keys);
          listComplete = listResult.list_complete;
          cursor = listResult.cursor;
        }

        const now = Date.now();
        const videos = [];
        for (const key of keys) {
          const jobString = await env.QUEUE_STORE.get(key.name);
          if (!jobString) continue;
          const job = JSON.parse(jobString);
          const completedChannels = job.completed_channels || [];
          const scheduledTime = new Date(job.scheduled_date).getTime();
          const channelIds = BRAND_CONFIG[job.brand] || [];
          
          let status = "scheduled";
          if (completedChannels.length > 0) {
            status = "partially posted";
          }
          if (now >= scheduledTime) {
            const hasPlaceholders = channelIds.some(id => id.startsWith("BUFFER_"));
            if (hasPlaceholders && completedChannels.length < channelIds.length) {
              status = "waiting on missing IDs";
            } else if (completedChannels.length === 0) {
              status = "failed/retrying"; 
            }
          }

          videos.push({
            id: key.name,
            brand: job.brand,
            title: job.title,
            download_url: job.download_url,
            scheduled_date: job.scheduled_date,
            status: status,
            completed_channels: completedChannels
          });
        }
        return new Response(JSON.stringify(videos), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      // Route matching for /api/videos/:id endpoints
      const videoMatch = path.match(/^\/api\/videos\/([a-zA-Z0-9-]+)(\/post-now)?$/);
      if (videoMatch) {
        const jobId = videoMatch[1];
        const isPostNow = !!videoMatch[2];

        // 3. POST /api/videos/:id/post-now
        if (method === "POST" && isPostNow) {
          const jobString = await env.QUEUE_STORE.get(jobId);
          if (!jobString) return new Response("Not found", { status: 404 });
          const job = JSON.parse(jobString);
          job.scheduled_date = new Date().toISOString(); // fast-track
          await env.QUEUE_STORE.put(jobId, JSON.stringify(job));
          return new Response(JSON.stringify({ success: true, message: "Video fast-tracked" }), { status: 200, headers: { "Content-Type": "application/json" } });
        }

        // 4. PATCH /api/videos/:id
        if (method === "PATCH" && !isPostNow) {
          const updates = await request.json();
          const jobString = await env.QUEUE_STORE.get(jobId);
          if (!jobString) return new Response("Not found", { status: 404 });
          const job = JSON.parse(jobString);
          
          Object.assign(job, updates); // Merge updates
          await env.QUEUE_STORE.put(jobId, JSON.stringify(job));
          return new Response(JSON.stringify({ success: true, job }), { status: 200, headers: { "Content-Type": "application/json" } });
        }

        // 5. DELETE /api/videos/:id
        if (method === "DELETE" && !isPostNow) {
          await env.QUEUE_STORE.delete(jobId);
          return new Response(JSON.stringify({ success: true, message: "Deleted" }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
      }

      return new Response("Not found", { status: 404 });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 400, headers: { "Content-Type": "application/json" } });
    }
  },

  async scheduled(event, env, ctx) {
    // List all keys in QUEUE_STORE
    let keys = [];
    let listComplete = false;
    let cursor = undefined;

    while (!listComplete) {
      const listResult = await env.QUEUE_STORE.list({ cursor });
      keys.push(...listResult.keys);
      listComplete = listResult.list_complete;
      cursor = listResult.cursor;
    }

    const now = Date.now();

    for (const key of keys) {
      // Parse the stored JSON values
      const jobString = await env.QUEUE_STORE.get(key.name);
      if (!jobString) continue;

      try {
        const job = JSON.parse(jobString);
        // Track completed channels in the job itself
        job.completed_channels = job.completed_channels || [];
        const scheduledTime = new Date(job.scheduled_date).getTime();

        // If current time is greater than or equal to scheduled_date, process the job
        if (now >= scheduledTime) {
          const channelIds = BRAND_CONFIG[job.brand];

          if (!channelIds || channelIds.length === 0) {
            console.error(`No channels configured for brand: ${job.brand}`);
            // Optional: delete invalid job to prevent it from blocking forever
            await env.QUEUE_STORE.delete(key.name);
            continue;
          }

          let allDone = true;
          let jobModified = false;

          // Iterate over the channelIds mapped to the job's brand
          for (const channelId of channelIds) {
            // If already posted to this channel successfully, skip
            if (job.completed_channels.includes(channelId)) {
              continue;
            }

            // Skip placeholders that haven't been configured yet
            if (channelId.startsWith("BUFFER_")) {
              allDone = false; // We can't finish this job yet, waiting for user to configure
              console.log(`Skipping unconfigured channel: ${channelId}`);
              continue;
            }

            // Buffer GraphQL mutation
            const query = `
              mutation {
                createPost(
                  channelId: "${channelId}",
                  text: ${JSON.stringify(job.title)},
                  schedulingType: automatic,
                  mode: addToQueue,
                  assets: [{ video: { url: ${JSON.stringify(job.download_url)} } }]
                ) {
                  post {
                    id
                  }
                }
              }
            `;

            // Select the appropriate access token based on the brand
            let accessToken = "";
            if (job.brand === "FTN News") {
              accessToken = env.BUFFER_NEWS_ACCESS_TOKEN;
            } else if (job.brand === "FTN Sports") {
              accessToken = env.BUFFER_SPORTS_ACCESS_TOKEN;
            }

            // Send a fetch() POST request using Buffer GraphQL API
            const response = await fetch("https://api.buffer.com/1/graphql", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${accessToken || "YOUR_BUFFER_TOKEN"}`
              },
              body: JSON.stringify({ query })
            });

            if (!response.ok) {
              console.error(`Failed to post to Buffer channel ${channelId} for job ${key.name}: ${response.statusText}`);
              allDone = false;
            } else {
              const resData = await response.json();
              if (resData.errors) {
                console.error(`Buffer GraphQL Error for job ${key.name}:`, resData.errors);
                allDone = false;
              } else {
                // Success! Record it.
                job.completed_channels.push(channelId);
                jobModified = true;
              }
            }
          }

          // If all non-placeholder channels succeeded and no placeholders remain, delete the job.
          if (allDone) {
            await env.QUEUE_STORE.delete(key.name);
          } else if (jobModified) {
            // Otherwise, if we successfully posted to some new channels, save our progress.
            await env.QUEUE_STORE.put(key.name, JSON.stringify(job));
          }
        }
      } catch (e) {
        console.error(`Error processing job ${key.name}: ${e.message}`);
      }
    }
  }
};

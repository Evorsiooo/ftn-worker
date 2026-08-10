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
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, x-api-key, Authorization",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const response = await this.handleRequest(request, env);
    
    // Append CORS headers to the response
    const newHeaders = new Headers(response.headers);
    for (const [key, value] of Object.entries(corsHeaders)) {
      newHeaders.set(key, value);
    }
    
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: newHeaders
    });
  },

  async handleRequest(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // Basic API Key Authentication (Headers or Query Params)
    const apiKey = request.headers.get("x-api-key") 
                || request.headers.get("Authorization")?.replace("Bearer ", "")
                || url.searchParams.get("api_key");
                
    if (apiKey !== env.API_KEY) {
      return new Response("Unauthorized", { status: 401 });
    }

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
            if (completedChannels.length >= channelIds.length && channelIds.length > 0) {
              status = "posted";
            } else {
              status = "partially posted";
            }
          }
          if (now >= scheduledTime && status !== "posted") {
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
          job.completed_channels = []; // force retry for debugging
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
    console.log("⏰ Cron job triggered. Checking QUEUE_STORE...");
    
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

    console.log(`Found ${keys.length} total videos in the queue.`);
    const now = Date.now();

    for (const key of keys) {
      const jobString = await env.QUEUE_STORE.get(key.name);
      if (!jobString) continue;

      try {
        const job = JSON.parse(jobString);
        job.completed_channels = job.completed_channels || [];
        const scheduledTime = new Date(job.scheduled_date).getTime();

        console.log(`Evaluating job ${key.name} (${job.title}). Scheduled for: ${new Date(scheduledTime).toISOString()}`);

        if (now >= scheduledTime) {
          console.log(`Job ${key.name} is DUE! Processing...`);
          const channelIds = BRAND_CONFIG[job.brand];

          if (!channelIds || channelIds.length === 0) {
            console.error(`No channels configured for brand: ${job.brand}`);
            await env.QUEUE_STORE.delete(key.name);
            continue;
          }

          let allDone = true;
          let jobModified = false;

          for (const channelId of channelIds) {
            if (job.completed_channels.includes(channelId)) {
              console.log(`Skipping channel ${channelId} - already posted successfully.`);
              continue;
            }

            if (channelId.startsWith("BUFFER_")) {
              allDone = false; 
              console.log(`Skipping unconfigured placeholder channel: ${channelId}`);
              continue;
            }

            console.log(`Attempting to post to Buffer channel: ${channelId}...`);

            const isInstagram = channelId === "6a789f17b2d9d5774345a91d" || channelId === "6a78b7c7b2d9d5774346590b";
            const metadataStr = isInstagram ? `metadata: { instagram: { type: reel, shouldShareToFeed: true } }` : ``;

            const query = `
              mutation {
                createPost(input: {
                  channelId: "${channelId}",
                  text: ${JSON.stringify(job.title)},
                  schedulingType: automatic,
                  mode: shareNow,
                  assets: [{ video: { url: ${JSON.stringify(job.download_url)} } }]
                  ${metadataStr}
                }) {
                  ... on PostActionSuccess {
                    post {
                      id
                    }
                  }
                  ... on MutationError {
                    message
                  }
                }
              }
            `;

            let accessToken = "";
            if (job.brand === "FTN News") {
              accessToken = env.BUFFER_NEWS_ACCESS_TOKEN;
            } else if (job.brand === "FTN Sports") {
              accessToken = env.BUFFER_SPORTS_ACCESS_TOKEN;
            }

            if (!accessToken) {
              console.error(`ERROR: No Access Token found in secrets for brand: ${job.brand}`);
              allDone = false;
              continue;
            }

            const response = await fetch("https://api.buffer.com", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${accessToken}`
              },
              body: JSON.stringify({ query })
            });

            if (!response.ok) {
              console.error(`Buffer HTTP Error on channel ${channelId}: ${response.status} ${response.statusText}`);
              const errText = await response.text();
              console.error(`Buffer Error Details: ${errText}`);
              allDone = false;
            } else {
              const resData = await response.json();
              if (resData.errors) {
                console.error(`Buffer GraphQL Error for job ${key.name}:`, JSON.stringify(resData.errors));
                allDone = false;
              } else if (resData.data && resData.data.createPost && resData.data.createPost.message) {
                console.error(`Buffer Mutation Error on channel ${channelId} for job ${key.name}: ${resData.data.createPost.message}`);
                allDone = false;
              } else {
                console.log(`✅ Successfully posted to channel ${channelId}!`);
                job.completed_channels.push(channelId);
                jobModified = true;
              }
            }
          }

          if (allDone) {
            console.log(`🎉 Job ${key.name} posted to all channels. Keeping in queue for debugging/history.`);
            await env.QUEUE_STORE.put(key.name, JSON.stringify(job));
          } else if (jobModified) {
            console.log(`Job ${key.name} partially completed. Saving progress...`);
            await env.QUEUE_STORE.put(key.name, JSON.stringify(job));
          } else {
            console.log(`Job ${key.name} processing finished, but no new channels were successfully posted.`);
          }
        } else {
          console.log(`Job ${key.name} is NOT due yet.`);
        }
      } catch (e) {
        console.error(`Error processing job ${key.name}: ${e.message}`);
      }
    }
  }
};

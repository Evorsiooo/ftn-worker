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
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    try {
      const body = await request.json();

      // Validate incoming JSON body
      if (!body.brand || !body.title || !body.download_url || !body.scheduled_date) {
        return new Response(JSON.stringify({ error: "Missing required fields" }), {
          status: 400,
          headers: { "Content-Type": "application/json" }
        });
      }

      // Generate a unique ID for the job
      const jobId = crypto.randomUUID();

      // Store the parsed payload in QUEUE_STORE as a JSON string
      await env.QUEUE_STORE.put(jobId, JSON.stringify(body));

      return new Response(JSON.stringify({ success: true, jobId }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: "Invalid JSON payload" }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
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

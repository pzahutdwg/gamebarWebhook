# gamebarWebhook
Auto-updates gamebar


# AI Slop:
Yes. Since PM2 is already supervising the app, the cleanest pattern is:

1. GitHub sends a webhook when `main` is pushed.
2. A tiny separate Node.js webhook listener receives it.
3. That listener runs `git fetch` + `git pull`.
4. It tells PM2 to restart the actual application.

You do **not** want the application being updated to host its own webhook endpoint, because it would be killing/restarting itself in the middle of handling the request. Keep the webhook listener as a separate PM2 process.

GitHub's `push` webhook includes the branch in `ref`, such as `refs/heads/main`, so we can ignore pushes to other branches. ([GitHub Docs][1])

## 1. Example directory layout

Suppose your app is:

```text
/home/pi/myapp/
    app.js
    package.json
    ...
```

And PM2 currently runs it as:

```bash
pm2 start app.js --name myapp
```

Create the webhook listener somewhere **outside** that repository:

```text
/home/pi/github-webhook/
    webhook.js
```

This prevents `git pull` from modifying the webhook listener itself.

## 2. Create the webhook listener

```bash
mkdir ~/github-webhook
cd ~/github-webhook
nano webhook.js
```

Paste:

```javascript
const http = require("http");
const crypto = require("crypto");
const { exec } = require("child_process");

const PORT = 9000;

// CHANGE THESE
const WEBHOOK_SECRET = "PUT_A_RANDOM_SECRET_HERE";
const APP_DIRECTORY = "/home/pi/myapp";
const PM2_APP_NAME = "myapp";

function verifySignature(body, signature) {
    if (!signature) return false;

    const expected =
        "sha256=" +
        crypto
            .createHmac("sha256", WEBHOOK_SECRET)
            .update(body)
            .digest("hex");

    const expectedBuffer = Buffer.from(expected);
    const signatureBuffer = Buffer.from(signature);

    if (expectedBuffer.length !== signatureBuffer.length)
        return false;

    return crypto.timingSafeEqual(
        expectedBuffer,
        signatureBuffer
    );
}

const server = http.createServer((req, res) => {

    if (req.method !== "POST" || req.url !== "/github") {
        res.writeHead(404);
        res.end("Not found");
        return;
    }

    let body = "";

    req.on("data", chunk => {
        body += chunk;
    });

    req.on("end", () => {

        const signature =
            req.headers["x-hub-signature-256"];

        if (!verifySignature(body, signature)) {
            console.log("Invalid webhook signature");

            res.writeHead(403);
            res.end("Forbidden");
            return;
        }

        let payload;

        try {
            payload = JSON.parse(body);
        } catch {
            res.writeHead(400);
            res.end("Invalid JSON");
            return;
        }

        // Only update when MAIN changes
        if (payload.ref !== "refs/heads/main") {
            console.log("Ignoring push to:", payload.ref);

            res.writeHead(200);
            res.end("Ignored");
            return;
        }

        console.log("Main branch updated.");
        console.log("Updating application...");

        // Respond to GitHub immediately
        res.writeHead(200);
        res.end("Update started");

        const command = `
            cd ${APP_DIRECTORY} &&
            git fetch origin &&
            git pull origin main &&
            npm install &&
            pm2 restart ${PM2_APP_NAME}
        `;

        exec(command, (error, stdout, stderr) => {

            if (error) {
                console.error("UPDATE FAILED:");
                console.error(error);
                return;
            }

            console.log(stdout);

            if (stderr)
                console.error(stderr);

            console.log("Update complete.");
        });
    });
});

server.listen(PORT, () => {
    console.log(`GitHub webhook listening on port ${PORT}`);
});
```

This uses GitHub's recommended `X-Hub-Signature-256` HMAC-SHA256 signature and a constant-time comparison rather than blindly accepting Internet requests. ([GitHub Docs][2])

## 3. Test the listener

Run:

```bash
node webhook.js
```

You should see:

```text
GitHub webhook listening on port 9000
```

Then stop it with:

```text
Ctrl+C
```

## 4. Put the webhook listener under PM2

Run:

```bash
cd ~/github-webhook
pm2 start webhook.js --name github-webhook
```

Check:

```bash
pm2 status
```

You should now have something like:

```text
github-webhook    online
myapp             online
```

Then:

```bash
pm2 save
```

PM2 recommends `pm2 save` to preserve the current process list for startup restoration. ([PM2][3])

## 5. Make the webhook accessible

GitHub needs to be able to reach:

```text
https://yourdomain.com/github
```

Since you already use Nginx for your Node applications, I would proxy `/github` to port `9000`.

For example:

```nginx
location /github {
    proxy_pass http://127.0.0.1:9000/github;
    proxy_http_version 1.1;

    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
}
```

Then:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

Now:

```text
https://yourdomain.com/github
```

reaches:

```text
localhost:9000/github
```

## 6. Configure GitHub

In your repository go to:

**Settings → Webhooks → Add webhook**

Set:

```text
Payload URL:
https://yourdomain.com/github
```

Content type:

```text
application/json
```

Secret:

```text
PUT_A_RANDOM_SECRET_HERE
```

That secret must exactly match:

```javascript
const WEBHOOK_SECRET = "PUT_A_RANDOM_SECRET_HERE";
```

For events select:

**Just the push event**

Then create the webhook.

GitHub will send its signature in `X-Hub-Signature-256`, which is why having that shared secret is important. ([GitHub Docs][4])

## 7. What happens when you push

You do:

```bash
git push origin main
```

GitHub sends:

```text
POST https://yourdomain.com/github
```

The webhook process checks:

```text
Is the signature valid?
        ↓
Is ref == refs/heads/main?
        ↓
git fetch origin
        ↓
git pull origin main
        ↓
npm install
        ↓
pm2 restart myapp
```

And PM2 keeps the deployment listener alive the whole time.

### One change I'd make

You actually **don't need to stop the app before pulling**.

Instead of:

```text
pm2 stop myapp
git pull
pm2 start myapp
```

do:

```text
git pull
pm2 restart myapp
```

PM2 is specifically designed to manage the process lifecycle, so letting the old process continue running while the files update and then restarting it minimizes downtime.

So the important deployment command is simply:

```bash
cd /home/pi/myapp &&
git fetch origin &&
git pull origin main &&
npm install &&
pm2 restart myapp
```

If this is one of your typical Node/Express apps and it doesn't need dependencies updated on every deployment, you can even drop `npm install`, making the whole thing very small.

[1]: https://docs.github.com/en/webhooks/webhook-events-and-payloads?utm_source=chatgpt.com "Webhook events and payloads - GitHub Docs"
[2]: https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries?utm_source=chatgpt.com "Validating webhook deliveries - GitHub Docs"
[3]: https://pm2.keymetrics.io/docs/usage/quick-start/?utm_source=chatgpt.com "PM2 - Quick Start"
[4]: https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/troubleshooting-webhooks?utm_source=chatgpt.com "Troubleshooting webhooks - GitHub Docs"

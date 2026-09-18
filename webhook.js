const http = require("http");
const crypto = require("crypto");
const { exec } = require("child_process");

const PORT = 9000;

// CHANGE THESE
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const APP_DIRECTORY = process.env.APP_DIRECTORY;
const PM2_APP_NAME = process.env.PM2_APP_NAME;

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
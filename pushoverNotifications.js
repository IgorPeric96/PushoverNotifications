import fs from 'fs';
import puppeteer from 'puppeteer';
import axios from 'axios';
import dotenv from 'dotenv';
import { spawn } from 'child_process';

dotenv.config();

const PUSHOVER_USER_KEY = process.env.PUSHOVER_USER_KEY;
const PUSHOVER_API_TOKEN = process.env.PUSHOVER_API_TOKEN;
const YOUTUBE_CHANNEL_URLS = process.env.YOUTUBE_CHANNEL_URLS 
  ? process.env.YOUTUBE_CHANNEL_URLS.split(",").map(url => url.trim())
  : [];

const CHECK_INTERVAL = 60 * 1000; // 1 minute

function logWithTimestamp(message) {
  console.log(`${new Date().toISOString()} - ${message}`);
}

// Function to restart the script
function restartScript() {
  logWithTimestamp("Restarting script due to error...");
  const child = spawn(process.argv[0], process.argv.slice(1), {
    stdio: 'inherit',
  });
  process.exit(1);
}

async function getLatestVideo(channelUrl) {
    let browser;
    try {
        browser = await puppeteer.launch({ args: ["--no-sandbox"], headless: true });
        const page = await browser.newPage();

        const selector = "ytd-rich-grid-media:first-child a#video-title-link";
        logWithTimestamp(`Navigating to channel page: ${channelUrl}`);

        try {
            await page.goto(channelUrl, { waitUntil: "networkidle2", timeout: 60000 });
        } catch (err) {
            logWithTimestamp(`Error navigating to ${channelUrl}: ${err.message}`);
            if (browser) await browser.close();
            restartScript(); // Restart on navigation timeout or similar error
        }

        // Scroll to ensure elements load
        await page.evaluate(() => window.scrollBy(0, 200));
        await new Promise(r => setTimeout(r, 300));

        const acceptButtonSelector = 'button[aria-label="Accept all"]';
        const acceptButton = await page.$(acceptButtonSelector);
        if (acceptButton) {
            logWithTimestamp("Accepting cookies");
            await page.click(acceptButtonSelector);
            await new Promise(r => setTimeout(r, 3000));
        }

        const latestVideo = await page.evaluate((sel) => {
            const element = document.querySelector(sel);
            if (!element) return null;
            const title = element.textContent.trim();
            const link = element.href;
            return { title, link };
        }, selector);

        await browser.close();

        if (!latestVideo) {
            logWithTimestamp(`Could not find the latest video for: ${channelUrl}`);
            return null;
        }

        return latestVideo;

    } catch (error) {
        if (browser) await browser.close();
        logWithTimestamp(`Unexpected error in getLatestVideo: ${error.message}`);
        restartScript(); // Restart on unexpected errors too
    }
}

function getLatestTitleFileName(channelUrl) {
    // Generate a filename based on the channel URL
    const safeName = channelUrl.replace(/[^a-z0-9]/gi, '_').toLowerCase();
    return `${safeName}_latest_title.txt`;
}

function readLastTitle(filename) {
    if (!fs.existsSync(filename)) {
        return null;
    }
    const title = fs.readFileSync(filename, "utf-8").trim();
    return title || null;
}

function writeLastTitle(title, filename) {
    fs.writeFileSync(filename, title, "utf-8");
}

async function sendPushoverNotification(video, channelUrl) {
    try {
        const channelName = channelUrl.split('@')[1]?.split('/')[0] || 'YouTube Channel';

        const pushoverPayload = {
            token: PUSHOVER_API_TOKEN,
            user: PUSHOVER_USER_KEY,
            message: `New video on ${channelName}: ${video.title}`,
            title: "New YouTube Video",
            url: video.link,
            url_title: "Watch Video",
            priority: 2, 
            sound: 'siren', 
            retry: 30, 
            expire: 3600
        };

        await axios.post('https://api.pushover.net/1/messages.json', pushoverPayload);
        logWithTimestamp("Pushover notification sent successfully!");
    } catch (error) {
        logWithTimestamp(`Failed to send Pushover notification: ${error.response ? JSON.stringify(error.response.data) : error.message}`);
    }
}

async function checkForNewVideo(channelUrl) {
    logWithTimestamp(`Checking for new video on: ${channelUrl}`);
    const latestVideo = await getLatestVideo(channelUrl);

    if (!latestVideo) {
        logWithTimestamp(`No video found for: ${channelUrl}`);
        return;
    }

    const latestTitleFile = getLatestTitleFileName(channelUrl);
    const storedTitle = readLastTitle(latestTitleFile);

    if (storedTitle === latestVideo.title) {
        logWithTimestamp(`No new video. The latest video is still: ${storedTitle}`);
        return;
    }

    logWithTimestamp(`New video detected: ${latestVideo.title}`);
    writeLastTitle(latestVideo.title, latestTitleFile);
    await sendPushoverNotification(latestVideo, channelUrl);
    logWithTimestamp("Update complete.");
}

async function checkForAllNewVideos() {
    logWithTimestamp("Checking all configured channels...");
    for (const channelUrl of YOUTUBE_CHANNEL_URLS) {
        await checkForNewVideo(channelUrl);
    }
}

// Initial check
checkForAllNewVideos();

// Check every minute
setInterval(checkForAllNewVideos, CHECK_INTERVAL);

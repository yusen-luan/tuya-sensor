// Import necessary modules
// node-fetch is used for making HTTP requests in a Node.js environment.
// It's a common practice for server-side fetch operations.
import fetch from 'node-fetch';
// The 'crypto' module is built into Node.js and provides cryptographic
// functionality, which is essential for generating the HMAC-SHA256 signature
// required by the Tuya API.
import crypto from 'crypto';

// --- Configuration ---
// IMPORTANT: Replace these with your actual Tuya IoT Platform credentials.
// It's highly recommended to use environment variables for these in a real
// Vercel deployment (e.g., process.env.TUYA_ACCESS_ID).
const TUYA_ACCESS_ID = process.env.CLIENT_KEY; // Your Tuya Cloud Project Access ID, from your curl command
const TUYA_ACCESS_SECRET = process.env.CLIENT_SECRET; // Your Tuya Cloud Project Access Secret
const TUYA_API_ENDPOINT = 'https://openapi.tuyaus.com'; // Or your specific region endpoint (e.g., openapi.tuyaeu.com, openapi.tuyain.com)
const DEVICE_ID = process.env.DEVICE_ID; // The ID of your temperature/humidity sensor device

/**
 * This serverless function connects to the Tuya API to fetch temperature and humidity data.
 * It follows the v2.0 API specification which requires a two-step process:
 * 1. Fetch a temporary access_token.
 * 2. Use the access_token to authenticate and fetch device data.
 */
export default async function handler(req, res) {
    // Set CORS headers to allow requests from any origin.
    // This is useful for development and if you plan to call this API
    // from a different domain (e.g., a web front-end).
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    // Handle preflight requests (OPTIONS method) for CORS.
    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    if (req.method !== 'GET') {
        // Only allow GET requests for this endpoint.
        return res.status(405).json({ error: 'Method Not Allowed', message: 'Only GET requests are supported.' });
    }

    try {
        const nonce = ''; // A random string, can be empty. Per Tuya docs, this is part of the signature.

        // --- Step 1: Get Access Token from Tuya API ---
        const tokenTimestamp = Date.now().toString();
        const tokenPath = '/v1.0/token?grant_type=1';
        const tokenMethod = 'GET';
        const tokenBody = '';
        const tokenContentHash = crypto.createHash('sha256').update(tokenBody).digest('hex');
        
        // As per Tuya Docs: stringToSign = HTTPMethod + "\n" + Content-SHA256 + "\n" + Headers + "\n" + URL
        const stringToSignForToken = `${tokenMethod}\n${tokenContentHash}\n\n${tokenPath}`;
        // As per Tuya Docs: str = client_id + t + nonce + stringToSign
        const stringToHmacForToken = TUYA_ACCESS_ID + tokenTimestamp + nonce + stringToSignForToken;

        const tokenSign = crypto.createHmac('sha256', TUYA_ACCESS_SECRET)
            .update(stringToHmacForToken, 'utf8')
            .digest('hex')
            .toUpperCase();

        const tokenUrl = `${TUYA_API_ENDPOINT}${tokenPath}`;
        const tokenResponse = await fetch(tokenUrl, {
            method: tokenMethod,
            headers: {
                'client_id': TUYA_ACCESS_ID,
                'sign': tokenSign,
                'sign_method': 'HMAC-SHA256',
                't': tokenTimestamp,
                'nonce': nonce,
                'Content-Type': 'application/json',
            },
        });

        const tokenData = await tokenResponse.json();
        if (!tokenResponse.ok || !tokenData.success) {
            console.error('Tuya API Error (Token):', tokenData);
            return res.status(tokenResponse.status).json({
                error: 'Failed to fetch access token from Tuya API',
                details: tokenData,
            });
        }
        const accessToken = tokenData.result.access_token;


        // --- Step 2: Get Device Shadow Properties using the Access Token ---
        const apiTimestamp = Date.now().toString();
        const apiPath = `/v2.0/cloud/thing/${DEVICE_ID}/shadow/properties`;
        const method = 'GET';
        const body = ''; // GET requests have no body
        const contentHash = crypto.createHash('sha256').update(body).digest('hex');
        
        // String to sign for API request: HTTPMethod\nContent-SHA256\nHeaders\nURL
        const stringToSignForApiRequest = `${method}\n${contentHash}\n\n${apiPath}`;
        // The final string to be encrypted: client_id + access_token + timestamp + nonce + stringToSign
        const stringToHmac = TUYA_ACCESS_ID + accessToken + apiTimestamp + nonce + stringToSignForApiRequest;

        const apiSign = crypto.createHmac('sha256', TUYA_ACCESS_SECRET)
            .update(stringToHmac, 'utf8')
            .digest('hex')
            .toUpperCase();

        const url = `${TUYA_API_ENDPOINT}${apiPath}`;

        // Make the API request to Tuya
        const response = await fetch(url, {
            method: method,
            headers: {
                'client_id': TUYA_ACCESS_ID,
                'access_token': accessToken,
                'sign': apiSign,
                'sign_method': 'HMAC-SHA256', // Specify the signing method
                't': apiTimestamp, // Timestamp
                'nonce': nonce,
                'Content-Type': 'application/json',
            },
        });

        // Check if the response was successful
        const data = await response.json();
        if (!response.ok || !data.success) {
            console.error('Tuya API Error:', data);
            return res.status(response.status).json({
                error: 'Failed to fetch data from Tuya API',
                details: data,
            });
        }

        // Extract temperature and humidity from the v2.0 API response.
        // The response contains a `properties` array.
        // You might need to inspect the 'data' object to find the correct `code` values.
        const properties = data.result?.properties;
        const temperature = properties?.find(s => s.code === 'temp_current' || s.code === 'va_temperature')?.value;
        const humidity = properties?.find(s => s.code === 'humidity_value' || s.code === 'va_humidity')?.value;

        if (temperature === undefined || humidity === undefined) {
             console.warn('Temperature or humidity data not found in Tuya response:', data);
             return res.status(404).json({
                 message: 'Temperature or humidity data not found for this device. Check device status codes.',
                 fullResponse: data
             });
        }

        // Send the extracted data back as a JSON response
        res.status(200).json({
            deviceId: DEVICE_ID,
            temperature: temperature / 10, // Tuya often returns temperature multiplied by 10
            humidity: humidity,
            unit: 'celsius', // Assuming Celsius, adjust if your sensor uses Fahrenheit
            fullTuyaResponse: data // Optional: include full response for debugging
        });

    } catch (error) {
        console.error('Serverless function error:', error);
        res.status(500).json({ error: 'Internal Server Error', message: error.message });
    }
}

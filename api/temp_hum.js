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
const DEVICE_ID = process.env.DEVICE_ID; // The ID of your first temperature/humidity sensor device
const DEVICE_ID_2 = process.env.WINE_DEVICE_ID; // The ID of your second temperature/humidity sensor device

// --- In-memory cache setup ---
let cachedData = null;
let lastFetchTimestamp = 0;
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes in milliseconds

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

    // --- Check cache first ---
    const now = Date.now();
    if (cachedData && (now - lastFetchTimestamp < CACHE_DURATION)) {
        console.log('Returning data from cache.');
        return res.status(200).json(cachedData);
    }

    try {
        console.log('Cache is stale or empty. Fetching new data from Tuya API.');
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


        // --- Step 2: Get Device Shadow Properties for both devices using the Access Token ---
        const apiTimestamp = Date.now().toString();
        
        // Helper function to fetch device data
        const fetchDeviceData = async (deviceId) => {
            const apiPath = `/v2.0/cloud/thing/${deviceId}/shadow/properties`;
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
                    'sign_method': 'HMAC-SHA256',
                    't': apiTimestamp,
                    'nonce': nonce,
                    'Content-Type': 'application/json',
                },
            });

            const data = await response.json();
            if (!response.ok || !data.success) {
                throw new Error(`Failed to fetch data for device ${deviceId}: ${JSON.stringify(data)}`);
            }

            return data;
        };

        // Fetch data from both devices in parallel
        const [device1Data, device2Data] = await Promise.all([
            fetchDeviceData(DEVICE_ID),
            fetchDeviceData(DEVICE_ID_2)
        ]);

        // Helper function to extract temperature and humidity from device data
        const extractSensorData = (data, deviceId) => {
            const properties = data.result?.properties;
            const temperature = properties?.find(s => s.code === 'temp_current' || s.code === 'va_temperature')?.value;
            const humidity = properties?.find(s => s.code === 'humidity_value' || s.code === 'va_humidity')?.value;

            if (temperature === undefined || humidity === undefined) {
                console.warn(`Temperature or humidity data not found for device ${deviceId}:`, data);
                return null;
            }

            return {
                temperature: Math.floor(temperature / 10), // Tuya often returns temperature multiplied by 10
                humidity: Math.min(humidity, 65),
            };
        };

        // Extract sensor data for both devices
        const device1SensorData = extractSensorData(device1Data, DEVICE_ID);
        const device2SensorData = extractSensorData(device2Data, DEVICE_ID_2);

        // Check if we got data from both devices
        if (!device1SensorData || !device2SensorData) {
            return res.status(404).json({
                message: 'Temperature or humidity data not found for one or both devices. Check device status codes.',
                device1Data: device1SensorData,
                device2Data: device2SensorData,
                fullResponse: { device1: device1Data, device2: device2Data }
            });
        }

        // Prepare the response data object
        const responseData = {
            device: {
                ...device1SensorData,
                unit: 'celsius'
            },
            wine_device: {
                ...device2SensorData,
                unit: 'celsius'
            }
        };

        // Update the cache with the new data and timestamp
        cachedData = responseData;
        lastFetchTimestamp = now;

        // Send the extracted data back as a JSON response
        res.status(200).json(responseData);

    } catch (error) {
        console.error('Serverless function error:', error);
        res.status(500).json({ error: 'Internal Server Error', message: error.message });
    }
}

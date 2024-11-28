const querystring = require('querystring');
const axios = require('axios');

const client_id = process.env.YAHOO_CONSUMER_KEY; // Store in Netlify env variables
const client_secret = process.env.YAHOO_CONSUMER_SECRET; // Store in Netlify env variables
const redirect_uri = "https://fantasy-recap.netlify.app/.netlify/functions/yahoo-callback";

// OAuth URL to redirect the user for authentication
const yahooOAuthHandler = async (event, context) => {
    const yahooAuthUrl = `https://api.login.yahoo.com/oauth2/request_auth?${querystring.stringify({
        client_id: client_id,
        redirect_uri: redirect_uri,
        response_type: 'code',
    })}`;

    return {
        statusCode: 302,
        headers: {
            Location: yahooAuthUrl,
        },
    };
};

// Function to refresh the access token using the refresh token
async function refreshAccessToken(refreshToken) {
    const tokenUrl = 'https://api.login.yahoo.com/oauth2/get_token';
    const body = querystring.stringify({
        client_id: client_id,
        client_secret: client_secret,
        redirect_uri: redirect_uri,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
    });

    try {
        const response = await axios.post(tokenUrl, body, {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
        });
        return response.data; // Returns the new access token, refresh token, and expiry time
    } catch (error) {
        console.error('Error refreshing access token:', error);
        throw error;
    }
}

// Export both the main OAuth handler and the refresh function
module.exports = { handler: yahooOAuthHandler, refreshAccessToken };

const querystring = require('querystring');
const axios = require('axios');

const client_id = process.env.YAHOO_CONSUMER_KEY; // Store in Netlify env variables
const client_secret = process.env.YAHOO_CONSUMER_SECRET; // Store in Netlify env variables
const redirect_uri = "https://fantasy-recap.netlify.app/.netlify/functions/yahoo-callback";

exports.handler = async (event, context) => {
    const code = event.queryStringParameters.code;

    const tokenUrl = 'https://api.login.yahoo.com/oauth2/get_token';
    const body = querystring.stringify({
        client_id: client_id,
        client_secret: client_secret,
        redirect_uri: redirect_uri,
        code: code,
        grant_type: 'authorization_code',
    });

    try {
        const response = await axios.post(tokenUrl, body, {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
        });

        const { access_token, refresh_token, expires_in } = response.data;

        // Return an HTML page that uses JavaScript to send the access token, refresh token, and expiry to the main window
        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'text/html',
            },
            body: `
                <!DOCTYPE html>
                <html>
                    <head>
                        <title>OAuth Callback</title>
                    </head>
                    <body>
                        <script type="text/javascript">
                            (function() {
                                // Check if the window has an opener (main window)
                                if (window.opener) {
                                    // Send the access token, refresh token, and expiry time to the main window
                                    window.opener.postMessage({
                                        accessToken: '${access_token}',
                                        refreshToken: '${refresh_token}',
                                        expiresIn: ${expires_in}
                                    }, '*');
                                    // Close the popup
                                    window.close();
                                } else {
                                    console.error('No window opener found.');
                                }
                            })();
                        </script>
                        <p>Authentication successful. You can close this window.</p>
                    </body>
                </html>
            `,
        };
    } catch (error) {
        console.error('OAuth error:', error);
        return {
            statusCode: 500,
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ error: 'OAuth failed' }),
        };
    }
};

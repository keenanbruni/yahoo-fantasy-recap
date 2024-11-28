const axios = require('axios');
const xml2js = require('xml2js');
const { refreshAccessToken } = require('./yahoo-oauth'); // Import the refresh token function

exports.handler = async (event) => {
    let accessToken = event.queryStringParameters.access_token;
    const refreshToken = event.queryStringParameters.refresh_token; // Get the refresh token

    if (!accessToken) {
        return {
            statusCode: 400,
            body: JSON.stringify({ error: "Missing access token" }),
        };
    }

    // Yahoo Fantasy API endpoint for fetching user leagues
    const apiUrl = `https://fantasysports.yahooapis.com/fantasy/v2/users;use_login=1/games;game_keys=nfl/leagues`;

    try {
        // Attempt to fetch the user's leagues
        const response = await axios.get(apiUrl, {
            headers: {
                Authorization: `Bearer ${accessToken}`,
            },
        });

        // Parse the XML response
        const parser = new xml2js.Parser({ explicitArray: false });
        const parsedData = await parser.parseStringPromise(response.data);

        // Extract leagues
        const leagues = parsedData.fantasy_content.users.user.games.game.leagues.league;

        // Normalize the leagues into an array if there's only one league
        const leaguesArray = Array.isArray(leagues) ? leagues : [leagues];

        // Extract relevant information (league ID and name) for each league
        const leagueList = leaguesArray.map((league) => ({
            league_id: league.league_id,
            name: league.name,
        }));

        return {
            statusCode: 200,
            body: JSON.stringify({ leagues: leagueList }),
        };
    } catch (error) {
        // Check if the error is due to an expired token
        if (error.response && error.response.status === 401 && refreshToken) {
            try {
                // Refresh the access token using the refresh token
                const newTokens = await refreshAccessToken(refreshToken);
                accessToken = newTokens.access_token;

                // Retry the API call with the new access token
                const retryResponse = await axios.get(apiUrl, {
                    headers: {
                        Authorization: `Bearer ${accessToken}`,
                    },
                });

                // Parse the XML response
                const parser = new xml2js.Parser({ explicitArray: false });
                const parsedData = await parser.parseStringPromise(retryResponse.data);

                // Extract leagues
                const leagues = parsedData.fantasy_content.users.user.games.game.leagues.league;
                const leaguesArray = Array.isArray(leagues) ? leagues : [leagues];

                // Extract relevant information (league ID and name) for each league
                const leagueList = leaguesArray.map((league) => ({
                    league_id: league.league_id,
                    name: league.name,
                }));

                return {
                    statusCode: 200,
                    body: JSON.stringify({ leagues: leagueList, new_access_token: newTokens.access_token, new_refresh_token: newTokens.refresh_token }),
                };
            } catch (refreshError) {
                console.error('Error refreshing access token:', refreshError);
                return {
                    statusCode: 401,
                    body: JSON.stringify({ error: 'Authentication failed' }),
                };
            }
        } else {
            console.error('Error fetching leagues:', error);
            return {
                statusCode: 500,
                body: JSON.stringify({ error: 'Failed to fetch leagues' }),
            };
        }
    }
};

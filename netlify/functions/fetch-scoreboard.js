const axios = require('axios');
const xml2js = require('xml2js');
const { refreshAccessToken } = require('./yahoo-oauth'); // Import the refresh token function

exports.handler = async (event, context) => {
    // Extract query parameters
    let accessToken = event.queryStringParameters.access_token;
    const refreshToken = event.queryStringParameters.refresh_token; // Get the refresh token
    const week = event.queryStringParameters.week;
    const league_id = "nfl.l." + event.queryStringParameters.league_id;

    if (!accessToken || !week || !league_id) {
        return {
            statusCode: 400,
            body: JSON.stringify({ error: "Missing required query parameters: access_token, week, or league_id" }),
        };
    }

    // Construct the Yahoo Fantasy API endpoint to fetch the scoreboard with roster data
    const apiUrl = `https://fantasysports.yahooapis.com/fantasy/v2/league/${league_id}/scoreboard;week=${week}/matchups/teams/roster/players`;

    try {
        // Step 1: Fetch the league scoreboard with roster data
        const response = await axios.get(apiUrl, {
            headers: {
                Authorization: `Bearer ${accessToken}`,
            },
        });

        const data = response.data;

        // Step 2: Extract player keys from the response
        const playerKeys = []; // Initialize an array to store player keys

        // Parse the XML response and extract player keys
        const parser = new xml2js.Parser({ explicitArray: false });
        const parsedData = await parser.parseStringPromise(data);
        const matchups = parsedData.fantasy_content.league.scoreboard.matchups.matchup;

        // Ensure matchups is always an array
        const matchupsArray = Array.isArray(matchups) ? matchups : [matchups];

        matchupsArray.forEach(matchup => {
            const teams = matchup.teams.team;
            // Ensure teams is always an array
            const teamsArray = Array.isArray(teams) ? teams : [teams];

            teamsArray.forEach(team => {
                const players = team.roster.players.player;
                // Ensure players is always an array
                const playersArray = Array.isArray(players) ? players : [players];

                playersArray.forEach(player => {
                    playerKeys.push(player.player_key);
                });
            });
        });

        // Step 3: Fetch player statistics using the player keys in batches
        const chunkArray = (array, size) => {
            const results = [];
            for (let i = 0; i < array.length; i += size) {
                results.push(array.slice(i, i + size));
            }
            return results;
        };

        const chunkSize = 25; // Adjust the chunk size as needed (Yahoo API allows up to 25)
        const playerKeyChunks = chunkArray(playerKeys, chunkSize);

        const playerStatsPromises = playerKeyChunks.map(async (chunk) => {
            const playerKeysParam = chunk.join(',');
            const playerStatsUrl = `https://fantasysports.yahooapis.com/fantasy/v2/players;player_keys=${playerKeysParam}/stats;type=week;week=${week}`;
            const playerStatsResponse = await axios.get(playerStatsUrl, {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                },
            });
            return playerStatsResponse.data;
        });

        // Optionally, limit concurrency if needed to prevent rate limiting
        const playerStats = [];
        for (const promise of playerStatsPromises) {
            playerStats.push(await promise);
        }

        // Return the scoreboard data along with player stats
        return {
            statusCode: 200,
            body: JSON.stringify({ scoreboard: data, playerStats }),
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

                const retryData = retryResponse.data;

                // Parse the XML response and extract player keys
                const parser = new xml2js.Parser({ explicitArray: false });
                const parsedData = await parser.parseStringPromise(retryData);
                const matchups = parsedData.fantasy_content.league.scoreboard.matchups.matchup;
                const matchupsArray = Array.isArray(matchups) ? matchups : [matchups];

                // Clear and refill player keys
                const playerKeys = [];
                matchupsArray.forEach(matchup => {
                    const teams = matchup.teams.team;
                    const teamsArray = Array.isArray(teams) ? teams : [teams];
                    teamsArray.forEach(team => {
                        const players = team.roster.players.player;
                        const playersArray = Array.isArray(players) ? players : [players];
                        playersArray.forEach(player => {
                            playerKeys.push(player.player_key);
                        });
                    });
                });

                // Fetch player statistics using the new player keys
                const playerKeyChunks = chunkArray(playerKeys, chunkSize);
                const playerStatsPromises = playerKeyChunks.map(async (chunk) => {
                    const playerKeysParam = chunk.join(',');
                    const playerStatsUrl = `https://fantasysports.yahooapis.com/fantasy/v2/players;player_keys=${playerKeysParam}/stats;type=week;week=${week}`;
                    const playerStatsResponse = await axios.get(playerStatsUrl, {
                        headers: {
                            Authorization: `Bearer ${accessToken}`,
                        },
                    });
                    return playerStatsResponse.data;
                });

                const playerStats = [];
                for (const promise of playerStatsPromises) {
                    playerStats.push(await promise);
                }

                // Return the updated scoreboard data along with player stats and new tokens
                return {
                    statusCode: 200,
                    body: JSON.stringify({ scoreboard: retryData, playerStats, new_access_token: newTokens.access_token, new_refresh_token: newTokens.refresh_token }),
                };
            } catch (refreshError) {
                console.error('Error refreshing access token:', refreshError);
                return {
                    statusCode: 401,
                    body: JSON.stringify({ error: 'Authentication failed' }),
                };
            }
        } else {
            console.error('Error fetching scoreboard or player stats:', error);
            return {
                statusCode: error.response?.status || 500,
                body: `Error generating summary: ${error.message}`,
            };
        }
    }
};

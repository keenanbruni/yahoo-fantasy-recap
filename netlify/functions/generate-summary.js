const axios = require('axios');
const cheerio = require('cheerio');
const xml2js = require('xml2js');
const fs = require('fs');

// Function to log data to a JSON file in development or console in production
function logToFile(logData) {
    if (process.env.NETLIFY_DEV === 'true') { // Check if running in development mode
        const logFilePath = './log.json';

        // Append the new log entry
        try {
            let existingLogs = [];

            // Read existing logs if the file exists
            if (fs.existsSync(logFilePath)) {
                const fileData = fs.readFileSync(logFilePath, 'utf8');
                existingLogs = JSON.parse(fileData);
            }

            // Add the new log data
            existingLogs.push(logData);

            // Write the updated log data to the file
            fs.writeFileSync(logFilePath, JSON.stringify(existingLogs, null, 2));
        } catch (err) {
            console.error('Error writing to the log file:', err);
        }
    } else {
        // Regular console logging when not in development mode
        console.log(logData);
    }
}

// Function to fetch and parse the matchup recap from Yahoo
async function fetchAndParseRecap(url) {
    try {
        const { data: html } = await axios.get(url); // Fetch the recap HTML
        const $ = cheerio.load(html); // Load HTML into Cheerio

        // Log the entire HTML response (only in development)
        if (process.env.NETLIFY_DEV === 'true') {
            logToFile({ message: `Fetched HTML from ${url}`, html, timestamp: new Date().toISOString() });
        }

        const heading = $('div.Mtop-xxl h1').text();
        const summaryParagraphs = [];

        // Example: Parse the summary text (adjust based on actual HTML structure)
        $('div.Mtop-xxl p').each((i, element) => {
            const paragraph = $(element).text();
            summaryParagraphs.push(paragraph.trim());
        });

        // Log the parsed recap details (only in development)
        if (process.env.NETLIFY_DEV === 'true') {
            logToFile({
                message: `Parsed recap details from ${url}`,
                recapDetails: {
                    heading,
                    summary: summaryParagraphs,
                },
                timestamp: new Date().toISOString(),
            });
        }

        return {
            heading,
            summary: summaryParagraphs,
        };

    } catch (error) {
        logToFile({ error: `Error fetching or parsing the recap: ${error.message}`, timestamp: new Date().toISOString() });
        return null;
    }
}

exports.handler = async (event) => {
    try {
        logToFile({ message: 'Start of generate-summary process', timestamp: new Date().toISOString() });

        // Parse the incoming request body
        const body = JSON.parse(event.body);

        // Extract mood from the request body
        const mood = body.mood || 'neutral'; // Default to 'neutral' if no mood is provided

        // Adjusted key names based on the incoming data
        const scoreboardData = body.scoreboardData?.scoreboard;
        const playerStatsData = body.scoreboardData?.playerStats;

        // Save the incoming data to a JSON file for debugging (only in development)
        if (process.env.NETLIFY_DEV === 'true') {
            const dataToSave = {
                scoreboardData: scoreboardData,
                playerStatsData: playerStatsData
            };
            fs.writeFileSync('./incomingStats.json', JSON.stringify(dataToSave, null, 2));
        }

        if (!scoreboardData || !playerStatsData) {
            logToFile({ error: 'Missing required data: scoreboardData or playerStatsData', timestamp: new Date().toISOString() });
            return {
                statusCode: 400,
                body: 'Missing required data: scoreboardData or playerStatsData.',
            };
        }

        // Parse the XML scoreboard data
        const parser = new xml2js.Parser({ explicitArray: false });
        let parsedScoreboard;
        try {
            parsedScoreboard = await parser.parseStringPromise(scoreboardData);
        } catch (parseError) {
            logToFile({ error: 'Error parsing XML scoreboard data', details: parseError.message, timestamp: new Date().toISOString() });
            return {
                statusCode: 400,
                body: 'Error parsing scoreboard data.',
            };
        }

        const league = parsedScoreboard.fantasy_content.league;
        const leagueId = league.league_id
        const leagueName = league.name || 'Unknown League';
        const matchups = league.scoreboard?.matchups?.matchup;
        const matchupArray = Array.isArray(matchups) ? matchups : [matchups];

        // Initialize an array to store team scores
        let teamScores = [];

        // Create a concise summary for the API request
        let summaryDetails = `League: ${leagueName}\nWeek: ${league.scoreboard.week}\n`;

        for (const matchup of matchupArray) {
            const teams = Array.isArray(matchup.teams.team) ? matchup.teams.team : [matchup.teams.team];
            const teamA = teams[0];
            const teamB = teams[1];

            // Push team scores into the array
            teamScores.push({
                name: teamA.name,
                score: parseFloat(teamA.team_points.total),
            });
            teamScores.push({
                name: teamB.name,
                score: parseFloat(teamB.team_points.total),
            });

            summaryDetails += `Matchup: ${teamA.name} 🆚 ${teamB.name}\n`;
            summaryDetails += `🏆 Winner: ${matchup.winner_team_key === teamA.team_key ? teamA.name : teamB.name}\n`;
            summaryDetails += `📊 Score: ${teamA.team_points.total} - ${teamB.team_points.total}\n`;

            // Extract the recap URL from the data (check if this exists in your data)
            const recapUrl = matchup.matchup_recap_url;

            if (recapUrl) {
                // Fetch and parse the recap from Yahoo
                const recapDetails = await fetchAndParseRecap(recapUrl);

                if (recapDetails && recapDetails.heading) {
                    summaryDetails += `${recapDetails.heading}\n\n`;
                    recapDetails.summary.forEach(paragraph => {
                        summaryDetails += `${paragraph}\n\n`;
                    });
                } else {
                    summaryDetails += 'Recap details not available for this matchup.\n';
                }
            } else {
                summaryDetails += 'Recap URL not available for this matchup.\n';
            }

            summaryDetails += '\n---\n';
        }

        // Sort the teamScores array from highest to lowest score
        teamScores.sort((a, b) => b.score - a.score);

        // Create variables for the highest and lowest scoring teams
        const highestScoringTeam = teamScores[0];
        const lowestScoringTeam = teamScores[teamScores.length - 1];

        // Append highest and lowest scoring team info to the summary details
        summaryDetails += `Highest Scoring Team: ${highestScoringTeam.name} with ${highestScoringTeam.score} points.\n`;
        summaryDetails += `Lowest Scoring Team: ${lowestScoringTeam.name} with ${lowestScoringTeam.score} points.\n`;

        // Construct the prompt for the OpenAI API
        const prompt = 
            `DATA: ${summaryDetails}. 
            Please generate a ${mood} flavored 4 sentence summary for each of the league matchups including player stats.
            <h1>🏈 <league name> - <week> 🏈</h1>
            Follow this formatting:
            Use emojis. Ensure to use ${mood} flavored references to each team's name in each summary. Omit matchup grades. Format in HTML, but dont mention it. Format it nicely.
            <h3>Matchup #: <Winning Team> 🆚 <Losing Team> </h3><br>
            🏆 Winner: <winner> <br>
            📊 Score: <winning score> - <losing score> <br> <br>
            Summary: <summary> <br> 
            
            At the end, create a highs and lows summary:
            <h2>Highs & Lows</h2>
            Praise summary 🏆 of highest overall scoring team, a line break, then 😞 shame summary for the lowest scoring team. Mention the scores. 
            `;

        // Log the summary details (only in development)
        if (process.env.NETLIFY_DEV === 'true') {
            logToFile({ message: 'Summary details for OpenAI prompt', summaryDetails, timestamp: new Date().toISOString() });
        }

        // Call the OpenAI API
        const response = await axios.post('https://api.openai.com/v1/chat/completions', {
            model: 'gpt-4o-mini', // always should be 4o mini
            messages: [
                { role: 'user', content: prompt },
            ],
            max_tokens: 1500,
            temperature: 0.7,
        }, {
            headers: {
                'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
                'Content-Type': 'application/json',
            },
        });

        // Clean up the summary content by removing code block markers and trimming spaces
        let cleanSummary = response.data.choices[0].message.content;
        cleanSummary = cleanSummary.replace(/```html|```/g, '').trim();

        // Return the cleaned summary
        return {
            statusCode: 200,
            body: JSON.stringify({ summary: cleanSummary }),
        };

    } catch (error) {
        logToFile({ error: error.message, timestamp: new Date().toISOString() });
        const errorMessage = `❌ Error generating summary: ${error.message}`;
        return {
            statusCode: 500,
            body: `Error generating summary: ${error.message}`,
        };
    }
};

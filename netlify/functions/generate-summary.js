const axios = require('axios');
const cheerio = require('cheerio');
const xml2js = require('xml2js');
const fs = require('fs');
const { sendPushoverNotification } = require('./sendPushoverNotification');

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
                if (fileData && fileData.trim().length > 0) {
                    try {
                        existingLogs = JSON.parse(fileData);
                        if (!Array.isArray(existingLogs)) existingLogs = [];
                    } catch (e) {
                        // Corrupted or partial file; reset logs safely
                        existingLogs = [];
                    }
                } else {
                    existingLogs = [];
                }
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
        const { data: html } = await axios.get(url, { timeout: 4000 }); // Fetch with tight timeout
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

// Helper: extract fantasy points from Yahoo player node (supports attribute-based totals)
function extractFantasyPoints(node) {
    const pp = node?.player_points;
    if (!pp) return NaN;
    // Some responses may be a string/number (unlikely but guard)
    if (typeof pp === 'string' || typeof pp === 'number') {
        const val = parseFloat(pp);
        return isNaN(val) ? NaN : val;
    }
    // Yahoo commonly encodes totals as attributes
    if (pp.total != null) {
        const val = parseFloat(pp.total);
        if (!isNaN(val)) return val;
    }
    if (pp.$ && pp.$.total != null) {
        const val = parseFloat(pp.$.total);
        if (!isNaN(val)) return val;
    }
    // Do NOT use coverage_value (that’s the week number, not points)
    return NaN;
}

// Helper: theme lexicon to enforce domain flavor
function getThemeLexicon(rawMood) {
    const mood = (rawMood || '').toLowerCase().trim();
    const map = {
        finance: {
            terms: ['portfolio', 'ROI', 'dividends', 'liquidity', 'hedge', 'bullish', 'bearish', 'alpha', 'volatility', 'arbitrage'],
            emojis: ['💹','📈','💸','🏦','📊']
        },
        medical: {
            terms: ['diagnosis', 'prognosis', 'triage', 'vital signs', 'dosage', 'stabilize', 'clinical', 'acute', 'remission', 'rehab'],
            emojis: ['🩺','💊','🧬','🏥','🧪']
        },
        tech: {
            terms: ['throughput', 'latency', 'scaling', 'pipeline', 'optimize', 'debug', 'deploy', 'stack', 'refactor', 'benchmark'],
            emojis: ['💻','⚙️','🚀','🧠','🧪']
        },
        pirate: {
            terms: ['plunder', 'bounty', 'broadside', 'keelhaul', 'quartermaster', 'mutiny', 'regatta', 'treasure', 'corsair', 'buccaneer'],
            emojis: ['🏴‍☠️','🦜','⚓','🗺️','💰']
        }
    };
    const fallback = { terms: ['surge', 'execution', 'momentum', 'strategy', 'pressure'], emojis: ['🔥','🏆','⚡','🎯'] };
    return map[mood] || fallback;
}

exports.handler = async (event) => {
    try {
        const start = Date.now();
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

        // Ensure API key is present EARLY (used below during per-matchup generation)
        const openAiKey = process.env.OPENAI_API_KEY;
        if (!openAiKey || openAiKey.trim() === '') {
            const msg = 'Missing OPENAI_API_KEY environment variable.';
            logToFile({ error: msg, timestamp: new Date().toISOString() });
            return { statusCode: 500, body: msg };
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

    // Initialize an array to store team scores and compact matchup data for the prompt
    let teamScores = [];
    const matchupsData = [];
    // We'll compose a compact JSON instead of a long string to keep token count low
    let summaryDetails = '';

        // Build Top Performers directly from the scoreboard roster (preferred: uses league-scored fantasy points if present)
        const topPlayersByTeam = {}; // teamName -> [{ name, points, player_key }]
        try {
            for (const matchup of matchupArray) {
                const teams = Array.isArray(matchup.teams.team) ? matchup.teams.team : [matchup.teams.team];
                for (const team of teams) {
                    const teamName = team.name;
                    const rosterPlayers = team?.roster?.players?.player;
                    const rosterArray = Array.isArray(rosterPlayers) ? rosterPlayers : (rosterPlayers ? [rosterPlayers] : []);
                    for (const player of rosterArray) {
                        const pKey = player.player_key || player.player_id;
                        const name = player?.name?.full || (player?.name?.first ? `${player?.name?.first} ${player?.name?.last}`.trim() : 'Unknown Player');
                        const points = extractFantasyPoints(player);
                        if (!isNaN(points)) {
                            if (!topPlayersByTeam[teamName]) topPlayersByTeam[teamName] = [];
                            topPlayersByTeam[teamName].push({ name, points, player_key: pKey });
                        }
                    }
                }
            }
            // If scoreboard didn't include player_points, fallback to playerStatsData parsing
            const haveAny = Object.keys(topPlayersByTeam).some(k => (topPlayersByTeam[k] || []).length > 0);
            if (!haveAny && playerStatsData) {
                const playerToTeamMap = {};
                for (const matchup of matchupArray) {
                    const teams = Array.isArray(matchup.teams.team) ? matchup.teams.team : [matchup.teams.team];
                    for (const team of teams) {
                        const teamName = team.name;
                        const rosterPlayers = team?.roster?.players?.player;
                        const rosterArray = Array.isArray(rosterPlayers) ? rosterPlayers : (rosterPlayers ? [rosterPlayers] : []);
                        for (const player of rosterArray) {
                            const pKey = player.player_key || player.player_id;
                            if (pKey) playerToTeamMap[pKey] = teamName;
                        }
                    }
                }
                const playerStatsDocs = Array.isArray(playerStatsData) ? playerStatsData : [playerStatsData];
                const statsParser = new xml2js.Parser({ explicitArray: false });
                for (const xml of playerStatsDocs) {
                    try {
                        const parsed = await statsParser.parseStringPromise(xml);
                        // Support both shapes depending on endpoint used
                        let playersNode = parsed?.fantasy_content?.players?.player;
                        if (!playersNode) {
                            playersNode = parsed?.fantasy_content?.league?.players?.player;
                        }
                        const playersArr = Array.isArray(playersNode) ? playersNode : (playersNode ? [playersNode] : []);
                        if (process.env.NETLIFY_DEV === 'true') {
                            logToFile({ message: 'Parsed players from playerStats doc', count: playersArr.length, timestamp: new Date().toISOString() });
                        }
                        for (const p of playersArr) {
                            const pKey = p.player_key;
                            const teamName = (pKey && playerToTeamMap[pKey]) || null;
                            const name = p?.name?.full || (p?.name?.first ? `${p?.name?.first} ${p?.name?.last}`.trim() : 'Unknown Player');
                            const points = extractFantasyPoints(p);
                            if (!teamName) continue;
                            if (isNaN(points)) continue;
                            if (!topPlayersByTeam[teamName]) topPlayersByTeam[teamName] = [];
                            topPlayersByTeam[teamName].push({ name, points, player_key: pKey });
                        }
                    } catch (innerErr) {
                        logToFile({ warning: 'Failed to parse a player stats XML document (fallback)', details: innerErr.message, timestamp: new Date().toISOString() });
                    }
                }
            }

            // Sort and keep top N per team to keep prompt compact
            const TOP_N = 2; // keep it tight to avoid long prompts
            Object.keys(topPlayersByTeam).forEach(teamName => {
                topPlayersByTeam[teamName].sort((a, b) => (b.points || 0) - (a.points || 0));
                topPlayersByTeam[teamName] = topPlayersByTeam[teamName].slice(0, TOP_N);
            });

            if (process.env.NETLIFY_DEV === 'true') {
                const exampleKeys = Object.keys(topPlayersByTeam).slice(0, 2);
                const example = exampleKeys.reduce((acc,k)=>{acc[k]=topPlayersByTeam[k];return acc;},{});
                logToFile({ message: 'Built Top Performers (from scoreboard, fallback to playerStats if needed)', example, timestamp: new Date().toISOString() });
                // Log a sample raw player_points node if available for the first team to help diagnose shapes
                const firstTeam = Object.keys(topPlayersByTeam)[0];
                if (firstTeam) {
                    const sampleName = topPlayersByTeam[firstTeam][0]?.name;
                    logToFile({ message: 'Sample Top Performer', team: firstTeam, player: sampleName, timestamp: new Date().toISOString() });
                }
                const counts = Object.fromEntries(Object.entries(topPlayersByTeam).map(([k,v]) => [k, v.length]));
                logToFile({ message: 'Top Performers counts per team', counts, timestamp: new Date().toISOString() });
                if (Object.keys(counts).length === 0 || Object.values(counts).every(c => c === 0)) {
                    logToFile({ message: 'No Top Performers found. Likely missing player_points in responses.', hint: 'Verify league-scoped players endpoint and presence of player_points.total', timestamp: new Date().toISOString() });
                }
            }
        } catch (aggErr) {
            logToFile({ warning: 'Aggregating player stats failed — summaries will omit player stats', details: aggErr.message, timestamp: new Date().toISOString() });
        }

        const shouldFetchRecaps = process.env.FETCH_RECAPS === 'true';

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

            // Collect compact matchup data for the prompt
            const topA = (topPlayersByTeam[teamA.name] || []).map(p => ({ n: p.name, p: Number(p.points?.toFixed(2)) }));
            const topB = (topPlayersByTeam[teamB.name] || []).map(p => ({ n: p.name, p: Number(p.points?.toFixed(2)) }));
            matchupsData.push({
                A: teamA.name,
                B: teamB.name,
                W: matchup.winner_team_key === teamA.team_key ? teamA.name : teamB.name,
                Sa: Number(teamA.team_points.total),
                Sb: Number(teamB.team_points.total),
                Ta: topA,
                Tb: topB,
            });

            // Note: we no longer add long recap text to avoid bloating the prompt
        }

        // Sort the teamScores array from highest to lowest score
        teamScores.sort((a, b) => b.score - a.score);

        // Create variables for the highest and lowest scoring teams
        const highestScoringTeam = teamScores[0];
        const lowestScoringTeam = teamScores[teamScores.length - 1];

        // Build compact JSON for the prompt
        const compactData = {
            L: leagueName,
            I: leagueId,
            W: league.scoreboard.week,
            M: matchupsData,
            H: { team: highestScoringTeam.name, s: highestScoringTeam.score },
            Lw: { team: lowestScoringTeam.name, s: lowestScoringTeam.score }
        };
        summaryDetails = JSON.stringify(compactData);

        // Construct the prompt(s) for the OpenAI API
        // Prepare per-matchup prompts to keep tokens and latency low and theme-aware
        const compact = JSON.parse(summaryDetails);
        const weekNum = compact.W;
        const perMatchupPrompt = (m) => {
            const tpA = (m.Ta || []).map(x => `${x.n} (${x.p} pts)`).join(', ');
            const tpB = (m.Tb || []).map(x => `${x.n} (${x.p} pts)`).join(', ');
            const lex = getThemeLexicon(mood);
            const termsList = (lex.terms || []).slice(0,6).join(', ');
            const emojiList = (lex.emojis || []).join('');
            return `Theme: ${mood}. League Week ${weekNum}. ${m.A} vs ${m.B}. Winner: ${m.W}. Score: ${m.Sa} - ${m.Sb}.\nTop performers ${m.A}: ${tpA || 'n/a'}. Top performers ${m.B}: ${tpB || 'n/a'}.\nUse at least 2 of these ${mood} terms: ${termsList}. Include at least 1 of these emojis: ${emojiList}.\nTask: Write 4 concise sentences in the ${mood} theme that mention 1-2 listed top performers BY NAME and POINTS (use the numbers exactly). Vary phrasing; avoid generic lines like 'edged', 'powered by', or 'momentum swung'. Do NOT output grades. Reply with ONLY the 4 sentences.`;
        };

        const callOpenAIChat = async (prompt, timeoutMs=6500) => {
            const resp = await axios.post('https://api.openai.com/v1/chat/completions', {
                model: 'gpt-4o-mini',
                messages: [{ role: 'user', content: prompt }],
                max_tokens: 280,
                temperature: 0.85,
            }, {
                headers: {
                    'Authorization': `Bearer ${openAiKey}`,
                    'Content-Type': 'application/json',
                },
                timeout: timeoutMs,
            });
            let text = resp.data.choices[0].message.content || '';
            return text.replace(/```[a-z]*|```/g, '').trim();
        };

        // Simple concurrency runner
        const runWithConcurrency = async (limit, items, worker) => {
            const results = new Array(items.length);
            let idx = 0, active = 0;
            return await new Promise((resolve) => {
                const next = () => {
                    if (idx >= items.length) { if (active === 0) resolve(results); return; }
                    const myIdx = idx++;
                    active++;
                    worker(items[myIdx], myIdx)
                        .then(r => { results[myIdx] = r; })
                        .catch(() => { results[myIdx] = null; })
                        .finally(() => { active--; next(); });
                };
                for (let i = 0; i < Math.min(limit, items.length); i++) next();
            });
        };

        // Generate per-matchup summaries with small prompts
        const matchupsArrayForGen = compact.M || [];
        if (process.env.NETLIFY_DEV === 'true') {
            logToFile({ message: 'Per-matchup generation starting', count: matchupsArrayForGen.length, timestamp: new Date().toISOString() });
        }
        const lex = getThemeLexicon(mood);
        const termA = lex.terms?.[0] || 'execution';
        const termB = lex.terms?.[1] || 'strategy';
        const emj = lex.emojis?.[0] || '🏆';
        const fallbackTemplates = [
            (m, aTop, bTop) => `${m.W} closed the book on ${m.A === m.W ? m.B : m.A} ${Math.max(m.Sa,m.Sb)}-${Math.min(m.Sa,m.Sb)} ${emj}. In ${mood} terms, ${m.W} showed ${termA} while ${m.A === m.W ? m.B : m.A} faced ${termB}. Standouts included ${aTop || bTop || 'key contributors'}. Both sides recalibrate for next week.`,
            (m, aTop, bTop) => `${m.W} outperformed ${m.A === m.W ? m.B : m.A} ${Math.max(m.Sa,m.Sb)}-${Math.min(m.Sa,m.Sb)} ${emj}. Highlights: ${aTop || bTop || 'top efforts'}. With a ${mood} lens, ${m.W} optimized ${termA} while the opponent struggled with ${termB}. New opportunities await.`,
            (m, aTop, bTop) => `${m.W} prevailed over ${m.A === m.W ? m.B : m.A} ${Math.max(m.Sa,m.Sb)}-${Math.min(m.Sa,m.Sb)} ${emj}. ${aTop || bTop || 'Key pieces'} set the tone. The ${mood} narrative favored ${m.W} in ${termA} while ${m.A === m.W ? m.B : m.A} lagged on ${termB}. Onward to next week.`,
        ];

        const perMatchupSummaries = await runWithConcurrency(3, matchupsArrayForGen, async (m, idx) => {
            const prompt = perMatchupPrompt(m);
            try {
                return await callOpenAIChat(prompt);
            } catch (e) {
                // Fallback: quick deterministic summary using given data
                const aTop = (m.Ta && m.Ta[0]) ? `${m.Ta[0].n} (${m.Ta[0].p} pts)` : '';
                const bTop = (m.Tb && m.Tb[0]) ? `${m.Tb[0].n} (${m.Tb[0].p} pts)` : '';
                const t = fallbackTemplates[idx % fallbackTemplates.length];
                return t(m, aTop, bTop);
            }
        });

        // Log the summary details (only in development)
        if (process.env.NETLIFY_DEV === 'true') {
            logToFile({ message: 'Summary details for OpenAI prompt (compact JSON)', summaryDetails, size: summaryDetails.length, timestamp: new Date().toISOString() });
        }

        // (API key presence was validated earlier)

        // Assemble final HTML from per-matchup results
        const headingHtml = `<h1>🏈 ${leagueName} - ${league.scoreboard.week} 🏈</h1>`;
        let blocks = '';
        perMatchupSummaries.forEach((txt, i) => {
            const m = matchupsArrayForGen[i];
            const win = m.W; const lose = (m.A === win) ? m.B : m.A;
            const wScore = (m.A === win) ? m.Sa : m.Sb;
            const lScore = (m.A === win) ? m.Sb : m.Sa;
            blocks += `<h3>Matchup ${i+1}: ${win} 🆚 ${lose}</h3><br>`;
            blocks += `🏆 Winner: ${win} <br>`;
            blocks += `📊 Score: ${wScore} - ${lScore} <br><br>`;
            blocks += `Summary: ${txt} <br>\n\n`;
        });
        const highsLows = `<h2>Highs & Lows</h2>🏆 ${highestScoringTeam.name} led the week with ${highestScoringTeam.score} points.<br>😞 ${lowestScoringTeam.name} struggled with just ${lowestScoringTeam.score} points.`;
        let cleanSummary = `${headingHtml}\n${blocks}\n${highsLows}`;

        // Send Pushover notification
    const durationMs = Date.now() - start;
    const notificationMessage = `Summary generated for week ${league.scoreboard.week}, league ${leagueName} - ${leagueId}. Mood: ${mood}. in ${durationMs}ms`;
    await sendPushoverNotification(notificationMessage);  

        // Return the cleaned summary
        return {
            statusCode: 200,
            body: JSON.stringify({ summary: cleanSummary }),
        };

    } catch (error) {
        logToFile({ error: error.message, timestamp: new Date().toISOString() });
        const errorMessage = `❌ Error generating summary: ${error.message}`;
        await sendPushoverNotification(errorMessage);
        return {
            statusCode: 500,
            body: `Error generating summary: ${error.message}`,
        };
    }
};

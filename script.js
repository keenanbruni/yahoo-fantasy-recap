document.addEventListener('DOMContentLoaded', async () => {
    const authButton = document.getElementById('authButton');
    const authStatus = document.getElementById('authStatus');
    const form = document.getElementById('fetchMatchupForm');
    const summaryText = document.getElementById('summaryText');
    const loadingIndicator = document.getElementById('loading');
    const leagueSelect = document.getElementById('leagueIdSelect');

    // Function to show the authentication status message
    const showAuthStatusMessage = (message) => {
        authStatus.textContent = message;
        authStatus.style.display = 'block';

        // Clear any existing fade-out classes and start the fade-out process
        authStatus.classList.remove('fade-out');
        setTimeout(() => {
            authStatus.classList.add('fade-out');
        }, 3000); // Wait for 3 seconds before starting the fade-out animation

        // Remove the message after the fade-out animation is complete
        setTimeout(() => {
            authStatus.style.display = 'none';
        }, 5000); // Total of 5 seconds
    };

    // Function to show the loading indicator with a fade-in-out effect
    const showLoading = () => {
        loadingIndicator.style.display = 'block';
        loadingIndicator.classList.add('fade-in-out');
    };

    // Function to hide the loading indicator
    const hideLoading = () => {
        loadingIndicator.classList.remove('fade-in-out');
        setTimeout(() => {
            loadingIndicator.style.display = 'none';
        }, 2000); // Matches the fade-out duration
    };

    // Function to fetch and populate the league dropdown
    const fetchLeagues = async (accessToken) => {
        try {
            const response = await fetch(`/.netlify/functions/fetch-leagues?access_token=${accessToken}`);
            if (!response.ok) {
                console.error('Failed to fetch leagues');
                return;
            }

            const leaguesData = await response.json();
            const leagues = leaguesData.leagues;

            // Clear existing options
            leagueSelect.innerHTML = '<option value="" disabled selected>Select your league</option>';

            // Populate dropdown with leagues
            leagues.forEach((league) => {
                const option = document.createElement('option');
                option.value = league.league_id;
                option.textContent = league.name;
                leagueSelect.appendChild(option);
            });
        } catch (error) {
            console.error('Error fetching leagues:', error);
        }
    };

    // Function to refresh the access token if needed
    const refreshAccessToken = async () => {
        const refreshToken = localStorage.getItem('yahoo_refresh_token');
        if (!refreshToken) return null;

        try {
            const response = await fetch('/.netlify/functions/yahoo-oauth-refresh', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ refreshToken }),
            });

            const data = await response.json();
            if (response.ok) {
                // Store the new tokens and expiration time
                localStorage.setItem('yahoo_access_token', data.access_token);
                localStorage.setItem('yahoo_refresh_token', data.refresh_token);
                localStorage.setItem('token_expiry', Date.now() + data.expires_in * 1000);
                console.log('Token refreshed successfully');
                return data.access_token;
            } else {
                console.error('Failed to refresh token:', data.error);
                return null;
            }
        } catch (error) {
            console.error('Error refreshing token:', error);
            return null;
        }
    };

    // Check if access token is expired and refresh if necessary
    const checkAndRefreshToken = async () => {
        const tokenExpiry = localStorage.getItem('token_expiry');
        if (!tokenExpiry || Date.now() >= tokenExpiry) {
            return await refreshAccessToken();
        }
        return localStorage.getItem('yahoo_access_token');
    };

    // Function to update the button text and functionality based on authentication state
    const updateAuthButton = (isAuthenticated) => {
        if (isAuthenticated) {
            authButton.textContent = 'Deauthenticate';
            authButton.removeEventListener('click', handleAuthButtonClick);
            authButton.addEventListener('click', handleDeauthButtonClick);
        } else {
            authButton.textContent = 'Authenticate with Yahoo';
            authButton.removeEventListener('click', handleDeauthButtonClick);
            authButton.addEventListener('click', handleAuthButtonClick);
        }
    };

    // Initialize the app by checking for an existing access token
    const initializeApp = async () => {
        const accessToken = await checkAndRefreshToken();
        if (accessToken) {
            showAuthStatusMessage('Authenticated successfully!');
            updateAuthButton(true); // Change to 'Deauthenticate'
            fetchLeagues(accessToken);
        } else {
            updateAuthButton(false); // Change to 'Authenticate with Yahoo'
        }
    };

    // Event listener for the "Authenticate with Yahoo" button
    const handleAuthButtonClick = () => {
        const oauthUrl = '/.netlify/functions/yahoo-oauth';
        const width = 600;
        const height = 600;
        const left = (screen.width / 2) - (width / 2);
        const top = (screen.height / 2) - (height / 2);

        window.open(oauthUrl, "Yahoo OAuth", `width=${width},height=${height},top=${top},left=${left}`);

        // Listen for the message from the popup
        window.addEventListener('message', (event) => {
            if (event.origin !== 'https://fantasy-recap.netlify.app') {
                return;
            }

            const { accessToken, refreshToken, expiresIn } = event.data;
            if (accessToken) {
                // Store tokens and expiration in localStorage
                localStorage.setItem('yahoo_access_token', accessToken);
                localStorage.setItem('yahoo_refresh_token', refreshToken);
                localStorage.setItem('token_expiry', Date.now() + expiresIn * 1000);
                console.log('Access Token:', accessToken);

                showAuthStatusMessage('Authenticated successfully!');
                updateAuthButton(true); // Change to 'Deauthenticate'

                // Fetch and populate leagues
                fetchLeagues(accessToken);
            }
        });
    };

    // Event listener for the "Deauthenticate" functionality
    const handleDeauthButtonClick = () => {
        // Clear all authentication data from localStorage
        localStorage.removeItem('yahoo_access_token');
        localStorage.removeItem('yahoo_refresh_token');
        localStorage.removeItem('token_expiry');

        // Reset UI
        authStatus.style.display = 'none';
        summaryText.textContent = 'You have been deauthenticated. Please log in again to continue.';
        updateAuthButton(false); // Change to 'Authenticate with Yahoo'
    };

    // Attach initial event listener for authentication
    authButton.addEventListener('click', handleAuthButtonClick);

    // Handle form submission
    form.addEventListener('submit', async (event) => {
        event.preventDefault();

        const week = document.getElementById('weekInput').value;
        const leagueId = leagueSelect.value; // Get the selected league ID
        const mood = document.getElementById('moodInput').value; // Get the mood input
        let accessToken = await checkAndRefreshToken();

        if (!week || !leagueId || !accessToken || !mood) {
            summaryText.textContent = 'Please enter the week number, select a league, specify a mood, and authenticate first.';
            return;
        }

        // Show loading indicator with fade-in-out effect
        showLoading();

        try {
            // Fetch the scoreboard data
            const scoreboardResponse = await fetch(`/.netlify/functions/fetch-scoreboard?access_token=${accessToken}&week=${week}&league_id=${leagueId}`, {
                method: 'GET',
            });

            if (!scoreboardResponse.ok) {
                summaryText.textContent = 'Could not fetch the scoreboard. Please check your inputs or try again later.';
                hideLoading();
                return;
            }

            const scoreboardData = await scoreboardResponse.json();
            console.log('Matchup data successfully pulled:', scoreboardData);

            // Generate the summary using the fetched scoreboard data
            const summaryResponse = await fetch('/.netlify/functions/generate-summary', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ scoreboardData, mood }), // Include mood in the request body
            });

            if (!summaryResponse.ok) {
                summaryText.textContent = 'Could not generate the summary. Please try again later.';
                hideLoading();
                return;
            }

            const { summary } = await summaryResponse.json();
            summaryText.innerHTML = summary;
        } catch (error) {
            summaryText.textContent = 'Error: ' + error.message;
            console.error('Error:', error);
        } finally {
            // Hide loading indicator after the request is complete
            hideLoading();
        }
    });

    // Initialize the app on load
    initializeApp();
});

import { Player } from './player.js';
import { Map as GameMap } from './map.js';
import { startChoppingCycle } from './behaviors/chopping.js';
import { startGatheringCycle } from './behaviors/gathering.js';
import { AudioManager } from './audio-manager.js';
import { PLAYER_STATE } from './player-state.js';
import { Camera } from './game/camera.js';
import * as StorageManager from './storage-manager.js';
import { finishChopping } from './behaviors/chopping.js';
import { beginChopping, beginHarvestingBushes, beginHarvestingLogs } from './behaviors/index.js';
import { DEFAULT_GAME_SETTINGS } from './game-settings.js';
import { setEnergyCooldown } from './twitch.js';
import { renderGame } from './game/renderer.js';
import { updateActiveChopping } from './game/chopping-manager.js';

export class Game {
    constructor(canvas, channel, worldName = 'default', hosts = [], settings = DEFAULT_GAME_SETTINGS) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.channel = channel;
        this.worldName = worldName;
        this.hosts = new Set(hosts.map(h => h.toLowerCase()));
        this.settings = settings;
        console.log("Game started with hosts:", this.hosts);
        console.log("Game started with settings:", this.settings);

        this.players = new Map();
        this.baseTileSize = 32;
        this.map = new GameMap(this.baseTileSize); // TileSize is 32
        this.camera = new Camera(this.canvas, this.map, this.players, this.settings);
        this.activeChoppingTargets = new Map();

        // Realtime communication for remote inventory
        this.room = null;
        this.pendingLinks = new Map(); // code -> { clientId, expiry }
        this.linkedPlayers = new Map(); // twitchUserId -> clientId
        this.liveViewUpdateTimer = 0;

        setEnergyCooldown(this.settings.energy.chat_cooldown_seconds);

        this.resize();
        window.addEventListener('resize', () => this.resize());
        window.addEventListener('keydown', (e) => this.handleKeyPress(e));
        
        // Mouse wheel zoom (on canvas only)
        this.canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            this.camera.handleWheel(e.deltaY);
        }, { passive: false });
        
        this.saveInterval = setInterval(async () => {
            await StorageManager.saveGameState(this.channel, this.worldName, this.players, this.map);
        }, 5000); // Save every 5 seconds
    }

    async init() {
        await this.initRealtime();
        await StorageManager.init(this.channel, this.worldName);
        const gameState = await StorageManager.loadGameState(this.channel, this.worldName);

        if (gameState.map && gameState.map.grid && gameState.map.grid.length > 0) {
            this.map.grid = gameState.map.grid;
            this.map.treeRespawns = gameState.map.treeRespawns || [];
        } else {
            this.map.generateMap();
        }

        if (gameState.players) {
            for (const id in gameState.players) {
                const state = gameState.players[id];
                if (state && state.id && state.username) {
                    const player = new Player(state.id, state.username, state.color, this.settings);
                    player.loadState(state);
                    this.players.set(id, player);
                }
            }
        }
        
        // Validate player states after loading everything
        for (const player of this.players.values()) {
            player.validateState(this.map, this);
        }

        this.resize();
        window.addEventListener('resize', () => this.resize());
        
        this.saveInterval = setInterval(async () => {
            await StorageManager.saveGameState(this.channel, this.worldName, this.players, this.map);
        }, 5000); // Save every 5 seconds
    }

    async initRealtime() {
        if (this.room) return;
        try {
            const project = await window.websim.getCurrentProject();
            const creator = await window.websim.getCreator();
            const user = await window.websim.getCurrentUser();

            // Only the project creator should act as the host
            if (user.id !== creator.id) {
                console.log("Not the project creator, real-time hosting disabled.");
                return;
            }

            console.log("Project creator detected. Initializing real-time host...");
            this.room = new WebsimSocket();
            await this.room.initialize();
            
            // Announce that the host is online for anyone already connected
            this.room.send({ type: 'host_online', hostId: this.room.clientId });

            // Make onmessage async so we can load data if needed
            this.room.onmessage = async (event) => {
                const data = event.data;
                const fromClientId = data.clientId;
                
                if (data.type === 'request_link') {
                    this.handleLinkRequest(fromClientId);
                } else if (data.type === 'request_host_info') {
                    console.log(`Received host info request from ${fromClientId}. Responding.`);
                    // A client just connected and is looking for the host.
                    // Broadcast our presence again so they can see it.
                    this.room.send({ type: 'host_online', hostId: this.room.clientId });
                } else if (data.type === 'auth_with_token') {
                    // Client is trying to authenticate with a previously issued token
                    const token = data.token;
                    if (!token) return;

                    let payload = null;
                    try {
                        const decoded = atob(token);
                        payload = JSON.parse(decoded);
                    } catch (e) {
                        console.warn("Failed to decode auth token:", e);
                        return;
                    }

                    if (!payload || !payload.userId || !payload.exp) {
                        console.warn("Invalid auth token payload.");
                        return;
                    }

                    const now = Date.now();
                    if (now > payload.exp) {
                        console.log(`Auth token for user ${payload.userId} has expired.`);
                        return;
                    }

                    // Ensure player exists in current game; if not, try to find in saved state
                    let player = this.players.get(payload.userId);
                    if (!player) {
                        try {
                            const gameState = await StorageManager.loadGameState(this.channel, this.worldName);
                            const state = gameState.players && gameState.players[payload.userId];
                            if (state && state.id && state.username) {
                                player = new Player(state.id, state.username, state.color, this.settings);
                                player.loadState(state);
                                this.players.set(payload.userId, player);
                                // Validate state against current map
                                player.validateState(this.map, this);
                                console.log(`Restored player ${player.username} from storage for token auth.`);
                            } else {
                                console.log(`No stored player data found for userId ${payload.userId}.`);
                            }
                        } catch (e) {
                            console.error("Error restoring player from storage during token auth:", e);
                        }
                    }

                    if (!player) {
                        console.log(`Auth token references unknown playerId ${payload.userId}.`);
                        return;
                    }

                    // Link this player to the client
                    // Unlink any previous client linked to this player
                    for (const [key, value] of this.linkedPlayers.entries()) {
                        if (key === player.id || value === fromClientId) {
                            this.linkedPlayers.delete(key);
                        }
                    }
                    this.linkedPlayers.set(player.id, fromClientId);
                    console.log(`Player ${player.username} authenticated via saved token for client ${fromClientId}.`);

                    // Let the client know the link is active (no new token needed)
                    this.room.send({
                        type: 'link_success',
                        forClientId: fromClientId,
                        username: player.username
                    });

                    // Send an immediate live view update
                    this.sendLiveViewUpdate(player);
                }
            };
        } catch (error) {
            console.error("Failed to initialize real-time features:", error);
        }
    }

    handleLinkRequest(clientId) {
        if (!this.room) return;
        
        const code = Math.random().toString(36).substring(2, 8).toUpperCase();
        this.pendingLinks.set(code, { clientId, expiry: Date.now() + 5 * 60 * 1000 }); // 5 min expiry
        
        // Broadcast the code, the specific client will pick it up
        this.room.send({ 
            type: 'pairing_code', 
            forClientId: clientId, 
            code: code 
        });
        
        console.log(`Generated pairing code ${code} for client ${clientId}`);
        
        // Clean up expired codes
        setTimeout(() => {
            if (this.pendingLinks.has(code)) {
                this.pendingLinks.delete(code);
                console.log(`Pairing code ${code} expired.`);
            }
        }, 5 * 60 * 1000);
    }

    sendLiveViewUpdate(player) {
        if (!this.room || !player || !this.linkedPlayers.has(player.id)) return;

        const clientId = this.linkedPlayers.get(player.id);
        const inventoryData = {
            logs: player.inventory.getLogCount(),
            leaves: player.inventory.getTotalLeaves(),
            flowers: player.inventory.flowers,
        };

        // Gather surrounding map data
        const VIEW_RADIUS = 16; // Increased radius so Live View shows a larger, more seamless region
        const mapChunkData = this.map.getChunk(player.pixelX, player.pixelY, VIEW_RADIUS);

        // Gather nearby players
        const nearbyPlayers = [];
        for (const otherPlayer of this.players.values()) {
            if (otherPlayer.id !== player.id && otherPlayer.isPowered()) {
                const dx = player.pixelX - otherPlayer.pixelX;
                const dy = player.pixelY - otherPlayer.pixelY;
                if (dx * dx + dy * dy < VIEW_RADIUS * VIEW_RADIUS) {
                    nearbyPlayers.push(otherPlayer.getState());
                }
            }
        }

        this.room.send({
            type: 'live_view_update',
            forClientId: clientId,
            payload: {
                inventory: inventoryData,
                playerState: player.getState(),
                mapChunk: mapChunkData,
                nearbyPlayers: nearbyPlayers,
            }
        });
    }

    resize() {
        this.canvas.width = window.innerWidth;
        this.canvas.height = window.innerHeight;
        
        // Use a fixed base tileSize for gameplay scale, allowing the map to be larger than viewport
        const fixedTileSize = this.baseTileSize; 
        // Apply current zoom level from camera
        const zoomedTileSize = fixedTileSize * (this.camera?.zoom || 1);
        this.map.setTileSize(zoomedTileSize);

        this.map.setViewport(this.canvas.width, this.canvas.height);
    }

    handleKeyPress(e) {
        if (e.code === 'Space') {
            e.preventDefault();
            this.camera.switchToNextPlayerFocus();
        }
    }

    handlePlayerCommand(userId, command, args) {
        const player = this.players.get(userId);
        if (!player) return;

        if (command === 'me') {
            if (this.settings.visuals.allow_me_command) {
                this.camera.setFocus(player.id);
                console.log(`[${player.username}] used !me command to focus camera.`);
            }
            return;
        }

        // --- Host Command Check ---
        if (command === 'energy') {
            if (!this.hosts.has(player.username.toLowerCase())) {
                console.log(`[${player.username}] tried to use host command !energy but is not a host.`);
                return;
            }

            const amount = args && !isNaN(args.amount) ? Math.max(1, Math.min(12, args.amount)) : 1;
            let targetPlayer = player;

            if (args && args.targetUsername) {
                const targetUsernameLower = args.targetUsername.toLowerCase();
                const foundTarget = Array.from(this.players.values()).find(p => p.username.toLowerCase() === targetUsernameLower);
                if (foundTarget) {
                    targetPlayer = foundTarget;
                } else {
                    console.log(`[${player.username}] tried to give energy to non-existent player "${args.targetUsername}".`);
                    return; // Target not found
                }
            }
            
            targetPlayer.addEnergy(amount);
            console.log(`[Host] ${player.username} gave ${amount} energy to ${targetPlayer.username}.`);
            return;
        }

        if (command === 'link') {
            const code = args.code ? args.code.toUpperCase() : null;
            if (this.room && code && this.pendingLinks.has(code)) {
                const linkData = this.pendingLinks.get(code);

                if (Date.now() > linkData.expiry) {
                    console.log(`[${player.username}] tried to use expired code ${code}.`);
                    this.pendingLinks.delete(code);
                    return;
                }
                
                // Unlink any old client associated with this twitch user
                for (const [key, value] of this.linkedPlayers.entries()) {
                    if (value === linkData.clientId) {
                        this.linkedPlayers.delete(key);
                    }
                }

                this.linkedPlayers.set(player.id, linkData.clientId);
                this.pendingLinks.delete(code);

                console.log(`[${player.username}] successfully linked their account with client ${linkData.clientId}.`);

                this.room.send({
                    type: 'link_success',
                    forClientId: linkData.clientId,
                    username: player.username
                });

                // Generate a simple JWT-like token (base64-encoded JSON) valid for 7 days
                const tokenPayload = {
                    userId: player.id,
                    username: player.username,
                    exp: Date.now() + 7 * 24 * 60 * 60 * 1000 // 7 days
                };
                try {
                    const token = btoa(JSON.stringify(tokenPayload));
                    this.room.send({
                        type: 'jwt_token',
                        forClientId: linkData.clientId,
                        token
                    });
                    console.log(`Issued JWT token for ${player.username} valid until ${new Date(tokenPayload.exp).toISOString()}`);
                } catch (e) {
                    console.error("Failed to generate JWT token:", e);
                }
                
                this.sendLiveViewUpdate(player);
            } else {
                console.log(`[${player.username}] tried to use invalid or non-existent code "${code}".`);
            }
            return;
        }

        if (!player.isPowered()) {
             console.log(`Player ${player.username} issued command "${command}" but has no energy.`);
             // Allow setting the command even without energy, it will start when they get some.
        }

        if (command === 'chop') {
            player.activeCommand = 'chop';
            player.followTargetId = null;
            if (player.isPowered()) {
                startChoppingCycle(player, this.map);
                console.log(`Player ${player.username} initiated !chop command.`);
            } else {
                 console.log(`Player ${player.username} set !chop command. It will start when they have energy.`);
            }
        } else if (command === 'gather') {
            player.activeCommand = 'gather';
            player.followTargetId = null;
            if (player.isPowered()) {
                startGatheringCycle(player, this.map);
                console.log(`Player ${player.username} initiated !gather command.`);
            } else {
                console.log(`Player ${player.username} set !gather command. It will start when it has energy.`);
            }
        } else if (command === 'follow') {
            let targetPlayer = null;
            if (args && args.targetUsername) {
                const targetUsernameLower = args.targetUsername.toLowerCase();
                // Find any player, even offline, to store their ID. The follow logic will handle if they are powered or not.
                targetPlayer = Array.from(this.players.values()).find(p => p.username.toLowerCase() === targetUsernameLower);
                 if (!targetPlayer) {
                    console.log(`[${player.username}] Could not find any player (online or off) named "${args.targetUsername}".`);
                    return;
                }
            } else {
                // Find nearest powered player
                let minDistance = Infinity;
                for (const otherPlayer of this.players.values()) {
                    if (otherPlayer.id === player.id || !otherPlayer.isPowered()) continue;
                    const dx = otherPlayer.pixelX - player.pixelX;
                    const dy = otherPlayer.pixelY - player.pixelY;
                    const distance = dx * dx + dy * dy;
                    if (distance < minDistance) {
                        minDistance = distance;
                        targetPlayer = otherPlayer;
                    }
                }
            }

            if (targetPlayer) {
                player.activeCommand = 'follow';
                player.followTargetId = targetPlayer.id;
                if (player.isPowered()) {
                    player.state = PLAYER_STATE.FOLLOWING;
                }
                console.log(`[${player.username}] will now follow ${targetPlayer.username}.`);
            } else {
                console.log(`[${player.username}] Could not find anyone nearby to follow.`);
                if (player.isPowered()) {
                    player.state = PLAYER_STATE.IDLE;
                }
            }
        }
    }

    addOrUpdatePlayer(chatter) {
        if (!chatter || !chatter.id) {
            console.error("Attempted to add or update player with invalid chatter data:", chatter);
            return;
        }
        let player = this.players.get(chatter.id);
        const wasPoweredBefore = player ? player.isPowered() : false;

        if (!player) {
            // Truly new player (not in persistence or current map)
            player = new Player(chatter.id, chatter.username, chatter.color, this.settings);
            this.players.set(chatter.id, player);
            
            // Ensure player is positioned correctly on the map, avoiding obstacles
            player.setInitialPosition(this.map);

            console.log(`Player ${chatter.username} joined.`);
            
            if (!this.camera.focusedPlayerId) {
                this.camera.setFocus(chatter.id);
            }
        } else {
             // Existing player (loaded from storage or currently active)
             // Update volatile data like username/color which might change
             player.username = chatter.username;
             player.color = chatter.color;
        }

        player.addEnergy();
        console.log(`Player ${player.username} gained energy. Current energy cells: ${player.energy.timestamps.length}`);

        // If a player who was not active just gained energy, and the camera is idle, focus on them.
        if (!wasPoweredBefore && player.isPowered() && !this.camera.focusedPlayerId) {
            console.log(`Camera was idle, now focusing on newly active player: ${player.username}`);
            this.camera.setFocus(player.id);
        }
    }

    start() {
        this.map.loadAssets().then(async () => {
            await this.init(); // Use the new async init
            this.lastTime = performance.now();
            this.gameLoop();
        });
    }

    gameLoop(currentTime = performance.now()) {
        const deltaTime = (currentTime - this.lastTime) / 1000; // in seconds
        this.lastTime = currentTime;

        this.update(deltaTime);
        this.render();

        requestAnimationFrame((time) => this.gameLoop(time));
    }

    update(deltaTime) {
        this.camera.update(deltaTime);
        updateActiveChopping(this, deltaTime);

        this.map.update(this.players);

        this.liveViewUpdateTimer += deltaTime;
        const shouldSendUpdate = this.liveViewUpdateTimer > (1 / 15); // 15 FPS updates

        for (const player of this.players.values()) {
            player.update(deltaTime, this.map, this.players, this);
            if (this.linkedPlayers.has(player.id) && shouldSendUpdate) {
                this.sendLiveViewUpdate(player);
            }
        }

        if (shouldSendUpdate) {
            this.liveViewUpdateTimer = 0;
        }
    }
    
    render() {
        renderGame(this);
    }
}
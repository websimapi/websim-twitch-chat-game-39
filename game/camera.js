import { project } from '../game/projection.js';

export class Camera {
    constructor(canvas, map, players, settings) {
        this.canvas = canvas;
        this.map = map;
        this.players = players;
        this.settings = settings;

        this.x = 0;
        this.y = 0;

        this.focusedPlayerId = null;
        this.focusTimer = 0;
        this.FOCUS_DURATION = 60; // seconds
    }

    setFocus(playerId) {
        this.focusedPlayerId = playerId;
        this.focusTimer = this.FOCUS_DURATION;
        const player = this.players.get(playerId);
        if (player) {
            console.log(`Camera focusing on: ${player.username} for ${this.FOCUS_DURATION} seconds.`);
        }
    }

    update(deltaTime) {
        this.focusTimer -= deltaTime;
        if (this.focusTimer <= 0) {
            this.chooseNewFocus();
            this.focusTimer = this.FOCUS_DURATION;
        }

        const focusedPlayer = this.focusedPlayerId ? this.players.get(this.focusedPlayerId) : null;
        const tileSize = this.map.tileSize;
        const viewMode = this.settings.visuals?.view_mode || '2d';

        if (focusedPlayer) {
            // Calculate projected center of player
            const projected = project(focusedPlayer.pixelX + 0.5, focusedPlayer.pixelY + 0.5, 0, viewMode, tileSize);
            const playerCenterX = projected.x;
            const playerCenterY = projected.y;

            // Smoothly interpolate camera position
            const lerpFactor = 1.0 - Math.exp(-10 * deltaTime); // Smooth damping
            
            // The camera x/y represents the top-left coordinate of the viewport in screen space units.
            // To center the player, we want (playerPos - cameraPos) = (screenWidth/2, screenHeight/2)
            // So targetCameraPos = playerPos - screenCenter
            
            const targetX = playerCenterX - this.canvas.width / 2;
            const targetY = playerCenterY - this.canvas.height / 2;

            this.x += (targetX - this.x) * lerpFactor;
            this.y += (targetY - this.y) * lerpFactor;

            // Clamping is tricky in 2.5D because the map isn't a rectangle. 
            // For now, we disable strict clamping in 2.5D or use a loose bound.
            if (viewMode === '2d') {
                const mapPixelWidth = this.map.width * tileSize;
                const mapPixelHeight = this.map.height * tileSize;

                if (mapPixelWidth > this.canvas.width) {
                    const maxCameraX = mapPixelWidth - this.canvas.width;
                    this.x = Math.max(0, Math.min(this.x, maxCameraX));
                } else {
                    this.x = -(this.canvas.width - mapPixelWidth) / 2;
                }

                if (mapPixelHeight > this.canvas.height) {
                    const maxCameraY = mapPixelHeight - this.canvas.height;
                    this.y = Math.max(0, Math.min(this.y, maxCameraY));
                } else {
                    this.y = -(this.canvas.height - mapPixelHeight) / 2;
                }
            }

        } else {
            // If no player, maybe center on map? 
            // For 2D, we did specific centering logic.
            // For 2.5D, let's just stay where we are or drift to 0,0 projected.
             if (viewMode === '2d') {
                const mapPixelWidth = this.map.width * tileSize;
                const mapPixelHeight = this.map.height * tileSize;
                if (this.canvas.width > mapPixelWidth) {
                     this.x = -(this.canvas.width - mapPixelWidth) / 2;
                }
                if (this.canvas.height > mapPixelHeight) {
                    this.y = -(this.canvas.height - mapPixelHeight) / 2;
                }
             }
        }
    }

    chooseNewFocus() {
        const activePlayers = Array.from(this.players.values()).filter(p => p.isPowered());

        if (activePlayers.length === 0) {
            this.focusedPlayerId = null;
            this.focusTimer = this.FOCUS_DURATION;
            console.log("No active players to focus on.");
            return;
        }

        const randomIndex = Math.floor(Math.random() * activePlayers.length);
        const player = activePlayers[randomIndex];

        this.focusedPlayerId = player.id;
        console.log(`Camera focusing on: ${player.username} for ${this.FOCUS_DURATION} seconds.`);
    }

    switchToNextPlayerFocus() {
        const activePlayers = Array.from(this.players.values()).filter(p => p.isPowered());

        if (activePlayers.length < 2) {
            console.log("Not enough active players to switch focus.");
            return;
        }

        activePlayers.sort((a, b) => a.username.localeCompare(b.username));

        let currentIndex = -1;
        if (this.focusedPlayerId) {
            currentIndex = activePlayers.findIndex(p => p.id === this.focusedPlayerId);
        }

        const nextIndex = (currentIndex + 1) % activePlayers.length;
        const nextPlayer = activePlayers[nextIndex];

        if (nextPlayer) {
            this.focusedPlayerId = nextPlayer.id;
            this.focusTimer = this.FOCUS_DURATION;
            console.log(`Camera focus switched to: ${nextPlayer.username}`);
        }
    }
}
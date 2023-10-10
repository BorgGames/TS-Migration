﻿import * as util from "./streaming-client/src/util.js";
import * as Msg from './streaming-client/src/msg.js';
import * as Factorio from './games/factorio.js';

import {Client} from './streaming-client/src/client.js';
import {ClientAPI} from "./client-api.js";
import {Ephemeral} from "./ephemeral.js";
import {OneDrivePersistence} from "./drive-persistence.js";
import {Session} from "./session.js";

import {getNetworkStatistics} from "./connectivity-check.js";
import {devMode} from "./dev.js";
import {SYNC} from "./onedrive.js";

const clientApi = new ClientAPI();
const status = document.getElementById('game-status');
const video = document.getElementById('stream');
const videoBitrate = document.getElementById('video-bitrate');

let controlChannel = null;

export class Home {
    static async init() {
        videoBitrate.addEventListener('input', changeBitrate);

        function changeBitrate() {
            const short = videoBitrate.value < 4 ? "low"
                : videoBitrate.value < 8 ? "medium"
                    : videoBitrate.value < 12 ? "high"
                        : "ultra";
            const qualityText = document.getElementById('video-quality');
            qualityText.innerText = videoBitrate.title = `${short} - ${videoBitrate.value} Mbps`;
            localStorage.setItem('encoder_bitrate', videoBitrate.value);
            if (controlChannel)
                controlChannel.send(Msg.config({encoder_bitrate: +videoBitrate.value}));
        }

        videoBitrate.value = parseInt(localStorage.getItem('encoder_bitrate')) || 2;
        changeBitrate();

        const loginButton = document.getElementById('loginButton');
        loginButton.addEventListener('click', () => {
            Home.login(true);
        });
        let loggedIn = await Home.login();
        if (!loggedIn && SYNC.account)
            loggedIn = await Home.login(true);

        loginButton.disabled = loggedIn;
    }

    static async login(loud) {
        let token;
        try {
            token = await SYNC.login(loud);
        } catch (e) {
            console.error(e);
        }
        if (token)
            await Home.showStorage();
        else if (!SYNC.account || loud)
            Home.showLogin();

        return !!token;
    }

    static async showStorage() {
        const response = await SYNC.makeRequest('');
        if (!response.ok) {
            console.error(response);
            Home.showLogin();
            return;
        }
        const items = await response.json();
        const progress = document.getElementById('space');
        progress.max = items.quota.total;
        progress.value = items.quota.used;
        const GB = 1024 * 1024 * 1024;
        progress.innerText = progress.title = `${Math.round(items.quota.used / GB)} GB / ${Math.round(items.quota.total / GB)} GB`;
        document.body.classList.add('sync');
        document.body.classList.remove('sync-pending');
    }

    static showLogin() {
        document.body.classList.remove('sync-pending');
    }

    static runClient(nodes, persistenceID, config, timeout) {
        const signalFactory = (onFatal) => new Ephemeral();

        return new Promise(async (resolve) => {
            const clients = [];

            function killOthers(current) {
                console.log('we have a winner!');
                for (let j = 0; j < clients.length; j++) {
                    if (clients[j] !== current)
                        clients[j].destroy(Client.StopCodes.CONCURRENT_SESSION);
                }
                clients.length = 1;
                clients[0] = current;
            }

            for (let i = 0; i < nodes.length; i++) {
                const offer = nodes[i];
                //set up client object with an event callback: gets connect, status, chat, and shutter events
                const client = new Client(clientApi, signalFactory, video, (event) => {
                    console.log('EVENT', event);

                    switch (event.type) {
                        case 'exit':
                            document.removeEventListener('keydown', hotkeys, true);
                            if (event.code !== Client.StopCodes.CONCURRENT_SESSION)
                                resolve(event.code);
                            else
                                clients.removeByValue(client);
                            break;
                        case 'status':
                            status.innerText = event.msg;
                            break;
                    }
                }, async (name, channel) => {
                    switch (name) {
                        case 'control':
                            await Session.waitForCommandRequest(channel);
                            const stats = await getNetworkStatistics(channel);
                            await Session.waitForCommandRequest(channel);
                            killOthers(client);
                            const launch = {
                                Launch: "borg:games/" + config.game,
                                PersistenceRoot: SYNC.isLoggedIn() ? persistenceID : undefined,
                            };
                            channel.send("\x15" + JSON.stringify(launch));
                            await Session.waitForCommandRequest(channel);
                            controlChannel = channel;
                            break;
                        case 'persistence':
                            if (SYNC.isLoggedIn()) {
                                const persistence = new OneDrivePersistence(channel, [persistenceID]);
                                console.log('persistence enabled');
                            }
                            break;
                    }
                });
                clients.push(client);

                //set up useful hotkeys that call client methods: destroy can also be used to cancel pending connection
                const hotkeys = (event) => {
                    event.preventDefault();

                    if (event.code === 'Backquote' && event.ctrlKey && event.altKey) {
                        client.destroy(0);
                    } else if (event.code === 'Enter' && event.ctrlKey && event.altKey) {
                        util.toggleFullscreen(client.element);
                    } else if (event.code === 'Slash' && event.ctrlKey && event.altKey) {
                        document.body.classList.toggle('video-overlay');
                    }
                };
                document.addEventListener('keydown', hotkeys, true);

                async function run() {
                    try {
                        const info = JSON.parse(offer.peer_connection_offer);
                        const sdp = JSON.parse(info.Offer);

                        const encoder_bitrate = parseInt(localStorage.getItem('encoder_bitrate')) || 2;

                        await Promise.race([
                            timeout,
                            client.connect(offer.session_id, sdp, {
                                encoder_bitrate
                            })]);
                    } catch (e) {
                        if (clients.removeByValue(client) && clients.length === 0)
                            resolve(e);
                    }
                }

                run();
            }
        });
    }

    static async launch(config) {
        const timeout = util.timeout(1000 /*s*/ * 60 /*m*/ * 3);

        try {
            if (!config.sessionId)
                config.sessionId = crypto.randomUUID();
            
            if (config.game === 'factorio' && !SYNC.isLoggedIn()) {
                if (!await showLoginDialog())
                    return;
            }

            document.body.classList.add('video');

            let persistenceID = undefined;
            if (SYNC.isLoggedIn())
                persistenceID = await ensureSyncFolders();

            if (config.game === 'factorio' && config.user) {
                if (await Factorio.loginRequired())
                    await Factorio.login(config.user, config.pwd);
            }

            status.innerText = 'looking for a node...';
            const nodes = await Ephemeral.getNodes();
            if (nodes.length === 0)
                throw new Error('No nodes currently available. Try again later.');

            const code = await Home.runClient(nodes, persistenceID, config, timeout);

            if (code !== 0)
                alert(`Exit code: ${code}`);
        } catch (e) {
            console.error(e);
            alert(e);
        } finally {
            controlChannel = null;
            document.body.classList.remove('video');

            video.src = '';
            video.load();
        }
    }
}

async function showLoginDialog() {
    const dialog = document.getElementById('login-dialog');
    dialog.style.display = 'flex';
    const promise = new Promise(async (resolve) => {
        const doLogin = async () => {
            try {
                resolve(await Home.login(true));
            } catch (e) {
                resolve(false);
            }
        };
        // if (SYNC.account)
        //     await doLogin();
        document.getElementById('onedriveLogin').onclick = doLogin;
        document.getElementById('cancelLogin').onclick = () => resolve(false);
    });
try {
    await promise;
} finally {
    dialog.style.display = 'none';
}
}

async function ensureSyncFolders() {
    const url = 'special/approot:/' + Factorio.LOCAL_DATA;
    let response = await SYNC.makeRequest(url, {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({folder: {}})
    });

    if (response.status === 409)
        response = await SYNC.makeRequest(url);

    if (!response.ok)
        throw new Error(`Failed to create Sync folder: HTTP ${response.status}: ${response.statusText}`);

    const item = await response.json();

    return item.id;
}
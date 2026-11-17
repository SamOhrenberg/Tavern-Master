# Tavern Master in pictures

Tavern Master is a self-hosted AI Dungeon Master for a few friends: upload the
rules of your game, start a campaign, and play together in real time with a DM
that looks rules up, rolls real dice and keeps the party's state on the server.
The [README](README.md) covers what it does and how it is built; this page
shows it.

Every screenshot is the real app, running against a local server with a real
campaign, on an iPhone 15 Plus–sized screen (430 × 932) as an app installed to
the Home Screen. The client is built phone-first, so this is how it is meant
to be played.

## Getting in

Sign-up is by invite only. On an iPhone, the app walks you through adding it to
the Home Screen, where it opens full screen with no browser bars.

<table>
  <tr>
    <td align="center" width="33%"><img src="screenshots/sign-in.png" alt="Sign-in screen with the Tavern Master crest, a Sign in / Join with invite toggle, and username and password fields" width="260"></td>
    <td align="center" width="33%"><img src="screenshots/install.png" alt="Add to Home Screen sheet with three numbered steps for Safari on iOS" width="260"></td>
    <td align="center" width="33%"><img src="screenshots/campaigns.png" alt="Campaigns list showing each campaign's game system, player count, ownership and whether it is still getting ready" width="260"></td>
  </tr>
  <tr>
    <td align="center"><b>Sign in</b><br>Invite-only accounts, argon2id and optional TOTP.</td>
    <td align="center"><b>Install</b><br>Step-by-step Add to Home Screen for iOS.</td>
    <td align="center"><b>Your table</b><br>Every campaign you are in, and its state.</td>
  </tr>
</table>

## Starting a campaign

A new campaign asks one big question first: who runs the game. The server's
own AI can, or the host's Claude can, on their own Claude plan with no API key.
The campaign then waits in a lobby while players build characters, either by
hand, from an uploaded sheet, or by talking it through with a character guide
that knows the rules and rolls real dice.

<table>
  <tr>
    <td align="center" width="33%"><img src="screenshots/new-campaign.png" alt="New campaign sheet asking who runs the game, Claude or the built-in AI, followed by name, rules system, premise and tone" width="260"></td>
    <td align="center" width="33%"><img src="screenshots/lobby.png" alt="Campaign lobby with the premise, an empty party, a Create your character button, wishes for the story, and Begin the adventure" width="260"></td>
    <td align="center" width="33%"><img src="screenshots/character-guide.png" alt="Character guide chat offering three ways to start: describe an idea, answer questions, or get three options" width="260"></td>
  </tr>
  <tr>
    <td align="center"><b>Who runs the game?</b><br>Built-in AI or Claude, chosen per campaign.</td>
    <td align="center"><b>The lobby</b><br>Build the party and say what you want from the story.</td>
    <td align="center"><b>Character guide</b><br>Talk a character into being; it fills the sheet as you go.</td>
  </tr>
</table>

## At the table

Players act, an AI companion who knows only what its character has seen acts
after them, and the DM answers the whole turn at once. Every roll is made by
the server and shown with its dice, and names the DM introduces link into the
codex.

<table>
  <tr>
    <td align="center" width="50%"><img src="screenshots/turn.png" alt="A turn: the player's line, the AI companion Desmond's response, and the Dungeon Master's reply with three server-rolled dice results" width="300"></td>
    <td align="center" width="50%"><img src="screenshots/narration.png" alt="Dungeon Master narration with highlighted codex names, ending on a question to the player, above the composer with Pass and Act" width="300"></td>
  </tr>
  <tr>
    <td align="center"><b>A turn</b><br>Player, then companion, then the DM with real rolls.</td>
    <td align="center"><b>Narration</b><br>Codex links in the prose; Pass is always there.</td>
  </tr>
</table>

## The party and the world

Characters, NPCs, places and the scene live in structured state on the server,
not in the model's memory. Every change the DM makes is a validated write that
the players can see in the journal.

<table>
  <tr>
    <td align="center" width="25%"><img src="screenshots/party.png" alt="Party tab with each character's hit points, ability scores, and who plays them, including a companion played by its own AI" width="200"></td>
    <td align="center" width="25%"><img src="screenshots/sheet.png" alt="Character sheet editor with hit points, abilities, class, level and background" width="200"></td>
    <td align="center" width="25%"><img src="screenshots/world.png" alt="World tab with the current scene, a codex search, and known people and places" width="200"></td>
    <td align="center" width="25%"><img src="screenshots/journal.png" alt="Journal tab listing state changes such as a new NPC, hit point changes and a new location" width="200"></td>
  </tr>
  <tr>
    <td align="center"><b>Party</b><br>Hit points, abilities, controllers.</td>
    <td align="center"><b>Sheet</b><br>Drawn from the system's template.</td>
    <td align="center"><b>World</b><br>The scene and the codex.</td>
    <td align="center"><b>Journal</b><br>Every change the DM made.</td>
  </tr>
</table>

## Running things

The host manages the campaign from its menu. Admins build a rules library per
game system: the DM searches only the campaign's own system, and cites the
passage it used. And anyone can connect their Claude to the server as a
connector.

<table>
  <tr>
    <td align="center" width="25%"><img src="screenshots/campaign-menu.png" alt="Campaign menu with members and presence, invites, the Dungeon Master setting with Switch to Claude, and campaign details" width="200"></td>
    <td align="center" width="25%"><img src="screenshots/library.png" alt="Rules library listing game systems with their book and passage counts" width="200"></td>
    <td align="center" width="25%"><img src="screenshots/game-system.png" alt="A game system's page with three ingested rulebooks marked Ready, and setting material" width="200"></td>
    <td align="center" width="25%"><img src="screenshots/claude.png" alt="Claude sheet with the connector address to copy and steps to add Tavern Master to Claude" width="200"></td>
  </tr>
  <tr>
    <td align="center"><b>Campaign menu</b><br>Members, the DM, the campaign.</td>
    <td align="center"><b>Rules library</b><br>One per game system.</td>
    <td align="center"><b>A game system</b><br>Rulebooks ingested on your hardware.</td>
    <td align="center"><b>Connect Claude</b><br>Paste one address into Claude.</td>
  </tr>
</table>

<p align="center">
  <img src="screenshots/you.png" alt="Account screen with two-factor sign-in, password, signed-in devices, Claude connection, your own API key and token usage" width="260"><br>
  <b>You</b><br>Security, your own API key, and what your campaigns have cost.
</p>

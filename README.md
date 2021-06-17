# A Discord bot for tracking information about Minecraft servers

## Notes
This project is work in progress.\
Also I got frustrated with existing, overly abstracted and object-oriented node modules
for interacting with the Discord Bot API, so I wrote my own, minimal, but also kind of bad module.\
Currently, it has a bug where it does not successfully catch exceptions that occur when a websocket
connection to Discord fails to be set up. This causes occasional crashes. I haven't bothered to look
into this so far and instead just wrap the execution of the bot in a shell script that restarts
it when it crashes.

## Installation

```
npm install --global https://github.com/SimonAlexPaul/mcserver-status-bot
```

## Running the bot

Create a config file in JSON format with the keys `botToken` and `statePath`:
```json
{
    "botToken": "<Your bot's token>",
    "statePath": "<File in which you want the bot's state to be stored>"
}
```
Assuming you named the config file config.json, run the bot like this:
```
mcserver-status-bot config.json
```
The state file will be created if does not exist.

## Usage

On a server that has the bot, send a message in the following format:
```
!!watchmcserver <address>:<port>
```
The bot should create a new message with information about the server.
In 20 second intervals, it will ask the minecraft server for new information, and update
the message if necessary.\
\
To remove the message and stop watching the server, send a message in the following format:
```
!!stopwatching <message id>
```

#!/bin/bash

# Install Angular CLI
npm install -g @angular/cli

# Install Claude Code
npm install -g @anthropic-ai/claude-code

# Install tmux for persistent sessions
sudo apt-get update && sudo apt-get install -y tmux

# Install sqlcmd for SQL Server connectivity
curl https://packages.microsoft.com/keys/microsoft.asc | sudo apt-key add -
curl https://packages.microsoft.com/config/ubuntu/22.04/prod.list \
  | sudo tee /etc/apt/sources.list.d/mssql-release.list
sudo apt-get update
sudo ACCEPT_EULA=Y apt-get install -y mssql-tools18 unixodbc-dev

echo 'export PATH="$PATH:/opt/mssql-tools18/bin"' >> ~/.bashrc

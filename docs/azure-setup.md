# Azure App Registration for Teams Notifications

## Prerequisites

- Microsoft 365 account with Teams
- Access to Azure Portal (portal.azure.com)

## Step 1: Register Application

1. Go to Azure Portal → Azure Active Directory → App registrations
2. Click "New registration"
3. Name: "Bodhilander"
4. Supported account types: "Accounts in any organizational directory and personal Microsoft accounts"
5. Redirect URI: Select "Public client/native" and enter: `https://bodhilander.app/auth/teams/callback`
6. Click "Register"

## Step 2: Configure API Permissions

1. Go to "API permissions"
2. Click "Add a permission"
3. Select "Microsoft Graph" → "Delegated permissions"
4. Add:
   - `User.Read`
   - `TeamsActivity.Send`
5. Click "Grant admin consent" (if you have admin rights, otherwise users consent individually)

## Step 3: Configure Teams Activity Types

1. Go to "Expose an API"
2. Set Application ID URI (e.g., `api://bodhilander`)
3. Create manifest file for Teams activity types (see below)

## Step 4: Get Client ID

1. Go to "Overview"
2. Copy "Application (client) ID"
3. Update `src/shared/teams-constants.ts` with this ID

## Teams Activity Types Manifest

Create Teams app manifest with activity types in Azure Portal or Teams Developer Portal.

Activity types needed:
- `sessionWaiting`: "⏳ {sessionName} needs input"
- `sessionError`: "❌ {sessionName} encountered an error"
- `sessionComplete`: "✅ {sessionName} finished"

'use strict';

console.log( process.env );

// ==============================================
// Load libraries
// ==============================================

// Salesforce client
const jsforce = require( 'jsforce' );

// Web server for handling requests
const express = require( 'express' );

// utility for parsing and formatting urls
const url = require( 'url' );

// general utility, for promisifying the exec library
const util = require( 'util' );

// for executing command line programs (e.g. Salesforce CLI)
// https://nodejs.org/api/child_process.html#child_process_child_process_exec_command_options_callback
// https://stackoverflow.com/questions/20643470/execute-a-command-line-binary-with-node-js
const exec = util.promisify( require( 'child_process' ).exec );

// file system utilities
const fs = require( 'fs' );
const fsp = fs.promises;

// operating system utilities
const os = require( 'os' );


// Salesforce OAuth Settings (reusable)
// ==============================================

var oauth2 = new jsforce.OAuth2({
    'loginUrl' : process.env.OAUTH_SALESFORCE_LOGIN_URL,
    'clientId' : process.env.OAUTH_SALESFORCE_CLIENT_ID,
    'clientSecret' : process.env.OAUTH_SALESFORCE_CLIENT_SECRET,
    'redirectUri' : process.env.OAUTH_SALESFORCE_REDIRECT_URI
});


// ==============================================
// Configure web app to respond to requests
// ==============================================

var app = express();

app.listen( process.env.PORT || 8080 );

/**
 * Handle when Heroku app base url is requested.
 * Will redirect to oauth endpoint to confirm user's identity.
 * Successful authorization will redirect to the /oauth2/callback endpoint
 * of one of the Heroku apps in the pipeline, it might not be *this* one.
 *
 * For example,
 *      If navigate to the Heroku app url for a "review app", this code
 *      will redirect to Salesforce for oauth authorization, which always redirects
 *      back to one of the Heroku apps configured in the Connected App's callback url.
 *      Where the Connected App redirects back to may not be *this* Heroku app but another one.
 *      The /oauth2/callback handler method in this script on *that* Heroku app will
 *      determine if the web request needs to be redirected to the original Heroku app.
 */
app.get( '/', function( req, res ) {

    var authURL = new URL( oauth2.getAuthorizationUrl( { scope : 'id' } ) );

    authURL.searchParams.append( 'state', JSON.stringify({
        'redirectURL' : 'https://' + process.env.HEROKU_APP_NAME + '.herokuapp.com'
    }));

    console.log( 'Redirecting to oauth authorization url', authURL );
    res.redirect( authURL );

});

/**
 * Receives oauth callback from Salesforce, hopefully, with authorization code.
 */
app.get( '/oauth2/callback', function( req, res ) {

    // In testing, browsers would send a duplicate request after 5 seconds
    // if this redirection did not respond in time.
    // To avoid having a duplicate request, we must tell the browser to wait longer.
    // https://github.com/expressjs/express/issues/2512
    req.connection.setTimeout( 1000 * 60 * 10 ); // ten minutes

    var requestURL = new URL( url.format({
        'protocol' : req.protocol,
        'hostname' : req.hostname,
        'pathname' : req.path,
        'query' : req.query
    }));

    var state = JSON.parse( req.query.state );
    var redirectURL = new URL( state.redirectURL );

    // if we are on the server where we are redirecting, then do our magic
    // else, redirect on to the intended heroku app
    if ( redirectURL.hostname === requestURL.hostname ) {

        // initialize salesforce client for making the oauth authorization request
        var sfClient = new jsforce.Connection({ oauth2 : oauth2 });

        // salesforce oauth authorize request to get access token
        sfClient.authorize( req.query.code, function( err, userInfo ) {

            if ( err ) {

                handleError( err, res );

            } else {

                try {

                    var sfdxAuthUrlFilePath = 'vendor/sfdx/open-app-sfdxurl';
                    var sfdxAuthUrlFileData = process.env.SFDX_AUTH_URL;

                    console.log( 'sfdxAuthUrlFilePath=' + sfdxAuthUrlFilePath );
                    console.log( 'sfdxAuthUrlFileData=' + sfdxAuthUrlFileData );

                    Promise.resolve().then( function() {

                        if ( !sfdxAuthUrlFileData ) {
                            // Review apps are created and destroyed automatically, so we
                            // never configure them with a SFDX_AUTH_URL environment variable.
                            // If we detect there is no SFDX_AUTH_URL, then look for file on disk.
                            // The 'bin/compile' script of the buildpack, for review apps,
                            // writes the sfdx auth url of the scratch org in a file named
                            // after the heroku app with a 'ra-' prefix.
                            return fsp.readFile( `vendor/sfdx/ra-${process.env.HEROKU_APP_NAME}`, { 'encoding': 'UTF-8' } ).then( function( fileData ) {
                                sfdxAuthUrlFileData = fileData;
                            });
                        }

                    }).then( function() {

                        // get file handle so we can write the salesforce org's auth url into it for later step
                        return fsp.open( sfdxAuthUrlFilePath, 'w' );

                    }).then( function( fileHandle ) {

                        // write the auth url to file to be used with the force:auth:sfdxurl:store command
                        return fileHandle.writeFile( sfdxAuthUrlFileData );

                    }).then( function() {

                        // authenticate with cli so we can get a url to redirect user to
                        return exec( 'sfdx force:auth:sfdxurl:store --setalias sfdxorg --sfdxurlfile "' + sfdxAuthUrlFilePath + '" --noprompt --json' );

                    }).then( function( result ) {

                        // obtain the url to redirect user into the salesforce org without knowing the credentials
                        return exec( 'sfdx force:org:open --targetusername sfdxorg --urlonly --json' );

                    }).then( function( result ) {

                        // redirect user into the salesforce org, voila!
                        var jsonResult = JSON.parse( result.stdout );
                        res.redirect( jsonResult.result.url );

                    }).catch( function( err ) {

                        handleError( err, res );

                    });

                } catch ( err ) {

                    handleError( err, res );

                }

            }

        });

    } else {

        redirectURL.pathname = '/oauth2/callback';
        redirectURL.searchParams.append( 'state', req.query.state );
        redirectURL.searchParams.append( 'code', req.query.code );

        console.log( 'Redirecting to desired host: ' + redirectURL.toString() );
        res.redirect( redirectURL.toString() );

    }

});

/**
 * Helper function to log error to console then write to response.
 */
function handleError( err, res ) {

    console.error( err );

    res.status( 403 ).send( 'Unexpected internal error' );

};
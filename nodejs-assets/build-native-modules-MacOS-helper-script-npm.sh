#!/bin/bash
      # Helper script for Gradle to call npm on macOS in case it is not found
      export PATH=$PATH:/Users/mabu/Downloads/Miscellaneous/termix-mobile/node_modules/nodejs-mobile-react-native/node_modules/.bin:/Users/mabu/Downloads/Miscellaneous/termix-mobile/node_modules/node_modules/.bin:/Users/mabu/Downloads/Miscellaneous/termix-mobile/node_modules/.bin:/Users/mabu/Downloads/Miscellaneous/node_modules/.bin:/Users/mabu/Downloads/node_modules/.bin:/Users/mabu/node_modules/.bin:/Users/node_modules/.bin:/node_modules/.bin:/Users/mabu/node22/lib/node_modules/npm/node_modules/@npmcli/run-script/lib/node-gyp-bin:/Users/mabu/node22/bin:/Users/mabu/Library/Application Support/org.dfinity.dfx/bin:/usr/bin:/bin:/usr/sbin:/sbin
      npm $@
    
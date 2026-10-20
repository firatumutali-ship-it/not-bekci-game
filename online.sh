#!/bin/sh
cd "$(dirname "$0")"
[ -d node_modules ] || npm install
npm start &
sleep 3
echo "Asagidaki https://....lhr.life adresini arkadaslarina gonder. Bu pencereyi kapatma."
ssh -o StrictHostKeyChecking=no -R 80:localhost:3000 nokey@localhost.run

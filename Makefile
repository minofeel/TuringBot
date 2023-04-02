

# Start the bot with typechecking 
start:
	npx ts-node ./core/main.ts

# Start the bot without typechecking. Much faster, but not recommended when 
# troubleshooting or starting a prod instance.
fstart:
	npx ts-node --transpileOnly ./core/main.ts
# Install and update all dependancies
prep:
	npm i

# Format whole project
format:
	npx prettier -w .

# Check formatting for the whole project
check-formatting:
	npx prettier -c .
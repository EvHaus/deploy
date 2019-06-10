// @flow

import {type ConfigType, type ServerType} from './types/config';
import {
	deleteZipFile,
	getSources,
	validatePrivateKeyPath,
	zipUpCurrentDirectory,
} from './utils/local';
import {
	ensureTargetDirectoryExists,
	installAptUpdates,
	installNode,
	installNpmDependencies,
	installPm2,
	installYarn,
	restartServices,
	uploadZipToServer,
} from './utils/server';
import chalk from 'chalk';
import {type Command} from 'commander';
import inquirer from 'inquirer';
import nodeSSH from 'node-ssh';
import ora from 'ora';

type SshConnectConfigType = {
	host: string,
	passphrase?: ?string,
	password?: ?string,
	privateKey?: ?string,
	username: string,
};

// eslint-disable-next-line no-process-env
const DEPLOY_PW = process.env.DEPLOY_PW;

class Deploy {
	_sshPassword: string;

	config: ConfigType;

	program: Command;

	server: ServerType;

	constructor (config: ConfigType, program: Command) {
		this.config = config;
		this.program = program;
		this.run();
	}

	// Ask the user for the password to unlock their private SSH key
	async askSshPassword () {
		const result = await inquirer.prompt<{password: string}>([{
			message: 'What is your private SSH key passphrase?',
			name: 'password',
			type: 'password',
		}]);

		this._sshPassword = result.password;
	}

	// Connects to the target server
	connectToServer (): Promise<ServerType> {
		const {host, private_key_path, user} = this.config;

		const spinner = ora(`Connecting to ${chalk.yellow(host)}...`).start();

		// Only validate private key path if we're not using a password
		if (private_key_path && !DEPLOY_PW) validatePrivateKeyPath(private_key_path);

		const client = new nodeSSH();

		const connectConfig: SshConnectConfigType = {
			host,
			username: user,
		};

		if (DEPLOY_PW) {
			// Passwords are assumed to be base64 encoded
			const decoded = Buffer.from(DEPLOY_PW, 'base64').toString();
			connectConfig.password = decoded;
		} else {
			connectConfig.privateKey = private_key_path;
			connectConfig.passphrase = this._sshPassword;
		}

		return client.connect(connectConfig)
			.then((client: ServerType): ServerType => {
				spinner.succeed(`Connected to ${chalk.yellow(host)}`);
				return client;
			})
			.catch(async (err: Error): Promise<ServerType> => {
				if (DEPLOY_PW && err && err.message.includes('All configured authentication methods failed')) {
					spinner.fail(
						`Unable to connect to SSH server with DEPLOY_PW password. ` +
						`You either provided an invalid password or ` +
						`you need to set PasswordAuthentication to 'yes' in ` +
						`your server's /etc/ssh/sshd_config config file.`
					);
					throw err;
				}

				// This is what ssh2 returns when the password isn't right
				if (err && err.message.includes('Cannot parse privateKey')) {
					spinner.fail(`Wrong private SSH key password provided. Try again.`);
					await this.askSshPassword();
					return this.connectToServer();
				}

				spinner.fail(
					`${chalk.red('[FAILURE]')} Could not connect to remote server.`
				);
				throw err;
			});
	}

	debug = (msg: string) => {
		if (this.program.verbose) console.debug(chalk.gray(msg));
	};

	// The main run function
	async run (): Promise<void> {
		this.debug(`Executing 'run' command...`);

		try {
			if (!DEPLOY_PW) await this.askSshPassword();
			this.server = await this.connectToServer();

			await installAptUpdates(this.program, this.debug, this.server);
			await installNode(this.program, this.debug, this.server);
			await installYarn(this.program, this.debug, this.server);
			await installPm2(this.program, this.debug, this.server);

			await ensureTargetDirectoryExists(this.config, this.debug, this.server);
			const sources = await getSources(this.config, this.debug, this.program);
			const zipPath = await zipUpCurrentDirectory(sources, this.program);
			await uploadZipToServer({
				config: this.config,
				debug: this.debug,
				localZipPath: zipPath,
				program: this.program,
				server: this.server,
			});

			await installNpmDependencies(this.config, this.debug, this.program, this.server);
			await restartServices(this.program, this.config, this.debug, this.server);

			await deleteZipFile(this.program);

			// Quit after we're done
			return process.exit(0);
		} catch (err) {
			console.error(chalk.red(err.message));

			// Close the server connection
			if (this.server) this.server.dispose();

			return process.exit(1);
		}
	}
}

export default Deploy;

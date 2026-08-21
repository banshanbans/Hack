import {Config} from '@remotion/cli/config';

Config.setOverwriteOutput(true);
Config.setVideoImageFormat('jpeg');
Config.setJpegQuality(92);
Config.setConcurrency(4);
Config.setWebpackPollingInMilliseconds(500);
Config.setShouldOpenBrowser(false);

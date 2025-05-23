// Import dependencies
const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const { exec } = require('child_process');
const fs = require('fs');
const pino = require('pino');
const emailjs = require('@emailjs/nodejs');
const k8s = require('@kubernetes/client-node');
const multer = require('multer');

// Kubernetes configuration
const kc = new k8s.KubeConfig();
kc.loadFromDefault();
const k8sApi = kc.makeApiClient(k8s.CoreV1Api);

// Multer configuration for file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, '/output/input/'),
    filename: (req, file, cb) => {
        const jobId = req.body.job_id;
        const fileExt = file.originalname.split('.').pop() === 'pdb' ? 'pdb' : 'fasta';
        cb(null, `${jobId}.${fileExt}`);
    }
});
const upload = multer({ storage });

// Initialize Express app and logger
const app = express();
const logger = pino({
    transport: {
        target: 'pino-pretty',
        options: { colorize: true, levelFirst: true }
    }
});

// Middleware
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: false, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'build')));

// Monitor for job completion
function monitorJob(jobId, jobType, recipient) { // Need to handle failure case, and maybe timeout case better
    logger.info("Monitoring job: " + jobId);
    const completionCmd = `kubectl wait --for=condition=complete job/${jobId} --timeout=12h`;
    const failureCmd = `kubectl wait --for=condition=failed job/${jobId} --timeout=12h`;

    const completionProcess = exec(completionCmd);
    const failureProcess = exec(failureCmd);

    let failureOccurred = false;

    failureProcess.on('exit', (code) => {
        if (code === 0) {
            failureOccurred = true;
            logger.info(`${jobType} job ${jobId} failed, sending failure email.`);
            sendFailureEmail(recipient, jobId);
        } else {
            logger.info(`${jobType} job ${jobId} failure monitoring failed. May have taken longer than timeout`);
        }
    });

    completionProcess.on('exit', (code) => {
        if (!failureOccurred) {
            if (code === 0) {
                logger.info(`${jobType} job ${jobId} completed successfully, sending push email.`);
                sendSuccessEmail(recipient, jobId);
            } else {
                logger.info(`${jobType} job ${jobId} monitoring failed. May have taken longer than timeout`);
            }
        }
    });
}

const sendSuccessEmail = async (recipient, jobId) => {
    try {
        const response = await emailjs.send("service_key", "template_key", {
            recipient: recipient,
            jobId: jobId,
        },
            {
                publicKey: "PUBLICKEY",
                privateKey: "PRIVATEKEY",
            });
        logger.info('Email sent successfully:', response);
    } catch (error) {
        logger.info("Error sending email:", error);
    }
};

const sendFailureEmail = async (recipient, jobId) => {
    try {
        const response = await emailjs.send("service_key", "template_key", {
            recipient: recipient,
            jobId: jobId,
        },
            {
                publicKey: "PUBLICKEY",
                privateKey: "PRIVATEKEY",
            });
        logger.info('Email sent successfully:', response);
    } catch (error) {
        logger.info("Error sending email:", error);
    }
};

// Submit endpoint
app.post("/submit", upload.single('input_file'), (req, res) => {
    // Retrieve JSON from the POST body 
    var error = null;
    var job_id = null;
    var input_file = null;
    var input_file_name = null;
    var database = null;
    var num_seq = null;
    var tree_program = null;
    var asr_program = null;
    var align_program = null;
    var con_weight = null; // 0 to 0.05 default 0.02
    var min_leaves = null; // 5 to 20 default 10
    var email = null;

    try {
        // Get uploaded file from multer
        input_file = req.file;
        input_file_name = req.file.originalname;
        ({
            job_id,
            database,
            num_seq,
            tree_program,
            asr_program,
            align_program,
            con_weight,
            min_leaves,
            email
        } = req.body);

    } catch (err) {
        logger.error("Error parsing request:" + err);
        return res.status(400).json({ error: "There was an error parsing your request. Please ensure all fields are filled out." });
    }

    logger.info("Received Job: " + job_id);

    // If input file extension is .pdb, copy input file to /output/EzSEA_job_id/Visualization/seq.pdb
    if (input_file_name.endsWith('.pdb')) {
        const outputDir = `/output/EzSEA_${job_id}/Visualization`;
        const outputPath = path.join(outputDir, 'seq.pdb');
        fs.mkdirSync(outputDir, { recursive: true });
        fs.copyFile(input_file.path, outputPath, (err) => {
            if (err) {
                logger.error("Error copying input file:", err);
                return res.status(500).json({ error: "There was an error copying the input pdb file." });
            }
        });
    } else { // Else, run ESM 
        // Read header from input file
        fs.readFile(input_file.path, 'utf8', (err, data) => {
            if (err) {
                logger.error("Error reading input file, ESM run aborting: ", err);
                return res.status(500).json({ error: "There was an error reading the input file." });
            }
            const lines = data.split('\n');
            const header = lines[0].trim().slice(1);

            logger.info("Queuing ESMfold run: " + job_id);

            // Queueing kubectl job for ESMfold, job specs are first written out to file and then applied
            // This is a workaround for the k8sapi.createNamespacedPod not working properly (inproper formatting)
            const struct_command = {
                "apiVersion": "batch/v1",
                "kind": "Job",
                "metadata": {
                    "name": job_id + "-struct"
                },
                "spec": {
                    "backoffLimit": 2,
                    "template": {
                        "metadata": {
                            "labels": {
                                "id": job_id,
                                "type": "structure"
                            }
                        },
                        "spec": {
                            "containers": [{
                                "name": "ezsea",
                                "image": "us-central1-docker.pkg.dev/ncbi-research-cbb-jiang/esmfold-fpocket/esmfold-fpocket:latest",
                                "command": ["/bin/zsh", "-c"],
                                "args": [
                                    "mkdir -p /database/output/EzSEA_" + job_id + "/Visualization/ "
                                    + "&& ./run-esm-fold.sh -i /database/output/input/" + job_id
                                    + ".fasta --pdb /database/output/EzSEA_" + job_id + "/Visualization/"
                                    + "&& mv /database/output/EzSEA_" + job_id + "/Visualization/" + header + ".pdb /database/output/EzSEA_" + job_id + "/Visualization/seq.pdb" // esmfold output is formatted as [header].pdb, this can be an issue if the header length is too long
                                    + "&& fpocket -f /database/output/EzSEA_" + job_id + "/Visualization/seq.pdb" 
                                    + "&& mv /database/output/EzSEA_" + job_id + "/Visualization/*_out/pockets /database/output/EzSEA_" + job_id + "/Visualization/"
                                ],
                                "resources": {
                                    "requests": {
                                        "nvidia.com/gpu": "1",
                                        "cpu": "4",
                                        "memory": "32Gi",
                                        "ephemeral-storage": "5Gi"
                                    },
                                    "limits": {
                                        "nvidia.com/gpu": "1",
                                        "cpu": "4",
                                        "memory": "64Gi",
                                        "ephemeral-storage": "10Gi"
                                    }
                                },
                                "volumeMounts": [{
                                    "mountPath": "/database",
                                    "name": "ezsea-databases-volume"
                                }]
                            }],
                            "restartPolicy": "Never",
                            "nodeSelector": {
                                "cloud.google.com/gke-accelerator": "nvidia-tesla-a100",
                                "cloud.google.com/gke-accelerator-count": "1"
                            },
                            "volumes": [{
                                "name": "ezsea-databases-volume",
                                "persistentVolumeClaim": {
                                    "claimName": "ezsea-filestore-pvc"
                                }
                            }]
                        }
                    }
                }
            };

            fs.writeFile('gpu-job-config.json', JSON.stringify(struct_command, null, 2), (err) => {
                if (err) {
                    console.error('Error writing Kubernetes job config to file', err);
                }
            });

            exec("kubectl apply -f ./gpu-job-config.json", (err, stdout, stderr) => {
                if (err) {
                    error = "There was a problem initializing your job, please try again later";
                    console.error(err); // Pino doesn't give new lines
                } else {
                    logger.info("EzSEA structure job started:" + job_id);
                    //monitorJob(job_id + "-struct", "GPU");
                }
            });
        });
    }

    logger.info("Queuing EzSEA run: " + job_id);

    const run_command = {
        "apiVersion": "batch/v1",
        "kind": "Job",
        "metadata": {
            "name": job_id
        },
        "spec": {
            "backoffLimit": 2,
            "template": {
                "metadata": {
                    "labels": {
                        "id": job_id,
                        "type": "run"
                    }
                },
                "spec": {
                    "containers": [{
                        "name": "ezsea",
                        "image": "us-central1-docker.pkg.dev/ncbi-research-cbb-jiang/ezsea/ezsea-image:latest",
                        "args": [
                            "ezsea", "run",
                            "-i", `/database/${input_file.path}`,
                            "--output", `/database/output/EzSEA_${job_id}`,
                            "--db", `/database/database/${database}`,
                            "-n", String(num_seq),
                            "--fold", "none",
                            "--treeprogram", tree_program,
                            "--asrprogram", asr_program,
                            "--alignprogram", align_program,
                            "--threads", "4",
                            "--ec_table", "/database/database/ec_dict.pkl",
                            "--pdbtable", "/database/database/pdb_uniref.pkl",
                            "--minleaves", String(min_leaves),
                            "--conweight", String(con_weight),
                        ],
                        "resources": {
                            "requests": {
                                "cpu": "8",
                                "memory": "16Gi",
                                "ephemeral-storage": "5Gi"
                            },
                            "limits": {
                                "cpu": "8",
                                "memory": "32Gi",
                                "ephemeral-storage": "10Gi"
                            }
                        },
                        "volumeMounts": [{
                            "mountPath": "/database",
                            "name": "ezsea-database-volume"
                        }]
                    }],
                    "restartPolicy": "Never",
                    "volumes": [{
                        "name": "ezsea-database-volume",
                        "persistentVolumeClaim": {
                            "claimName": "ezsea-filestore-pvc"
                        }
                    }]
                }
            }
        }
    };

    fs.writeFile('cpu-job-config.json', JSON.stringify(run_command, null, 2), (err) => {
        if (err) {
            console.error('Error writing Kubernetes job config to file', err);
        }
    });

    // Forgoing k8sapi.createNamespacedPod, running into issues with proper formatting 
    exec("kubectl apply -f ./cpu-job-config.json", (err, stdout, stderr) => {
        if (err) {
            error = "There was a problem initializing your job, please try again later";
            console.error(err); // Pino doesn't give new lines
        } else {
            logger.info("EzSEA run job started: " + job_id);
            if (email) {
                monitorJob(job_id, "CPU", email);
            }
        }
    });

    setTimeout(function () {
        res.status(200).json({ body: "Job submitted successfully", error: error });
    }, 3000);
});

// Results endpoint
app.get("/results/:id", async (req, res) => {
    const id = req.params.id;
    const folderPath = `/output/EzSEA_${id}/Visualization`;
    const treePath = path.join(folderPath, 'asr.tree');
    const leafPath = path.join(folderPath, 'seq_trimmed.afa');
    const ancestralPath = path.join(folderPath, 'asr.fa');
    const nodesPath = path.join(folderPath, 'nodes.json');
    const pocketPath = path.join(folderPath, 'pockets');

    const pocketFiles = ['pocket1_atm.pdb', 'pocket2_atm.pdb', 'pocket3_atm.pdb', 'pocket4_atm.pdb', 'pocket5_atm.pdb'];
    // Read all pocket files

    const pocketPromises = pocketFiles.map((pocketFile) => {
        return fs.promises.readFile(path.join(pocketPath, pocketFile), 'utf8') // Read each pocket file
            .then(data => ({ pocket: data }))
            .catch(err => {
                logger.error("Error reading pocket file: " + err);
                return { pocketError: "Error reading a pocket file." };
            });
    });

    var structPath = ""; // TODO: UPDATE TO HARDCODED ../seq.pdb

    try {
        var pdbFiles = fs.readdirSync(folderPath).filter(fn => fn.endsWith('.pdb')); // Returns an array of pdb files
        if (!pdbFiles) {
            logger.error(`No PDB files found in folder: ${folderPath}`);
            structPath = null;
        } else {
            structPath = path.join(folderPath, pdbFiles[0]);
        }
    } catch (e) {
        logger.error("Failed to find pdb files: " + e);

    }

    const inputPath = `/output/EzSEA_${id}/input.fasta`;
    const ecPath = path.join(folderPath, 'ec.json');
    const asrPath = path.join(folderPath, 'seq.state.zst');

    logger.info("Serving results for job: " + id);

    // Read the files
    const treePromise = fs.promises.readFile(treePath, 'utf8')
        .then(data => ({ tree: data }))
        .catch(err => {
            logger.error("Error reading tree file: " + err);
            return { treeError: "Error reading tree file." };
        });

    const leafPromise = fs.promises.readFile(leafPath, 'utf8')
        .then(data => ({ leaf: data }))
        .catch(err => {
            logger.error("Error reading leaf file: " + err);
            return { leafError: "Error reading leaf file." };
        });

    const ancestralPromise = fs.promises.readFile(ancestralPath, 'utf8')
        .then(data => ({ ancestral: data }))
        .catch(err => {
            logger.error("Error reading ancestral file: " + err);
            return { ancestralError: "Error reading ancestral file." };
        });

    const nodesPromise = fs.promises.readFile(nodesPath, 'utf8')
        .then(data => ({ nodes: data }))
        .catch(err => {
            logger.error("Error reading nodes file: " + err);
            return { nodesError: "Error reading nodes file." };
        });

    const structPromise = fs.promises.readFile(structPath, 'utf8')
        .then(data => ({ struct: data }))
        .catch(err => {
            logger.error("Error reading struct file: " + err);
            return { structError: "Error reading struct file." };
        });

    const inputPromise = fs.promises.readFile(inputPath, 'utf8')
        .then(data => ({ input: data }))
        .catch(err => {
            logger.error("Error reading input file: " + err);
            return { inputError: "Error reading input file." };
        });

    const ecPromise = fs.promises.readFile(ecPath, 'utf8')
        .then(data => ({ ec: data }))
        .catch(err => {
            logger.error("Error reading ec file: " + err);
            return { ecError: "Error reading ec file." };
        });

    const asrPromise = fs.promises.readFile(asrPath)
        .then(data => ({ asr: data }))
        .catch(err => {
            logger.error("Error reading asr probability file: " + err);
            return { asrError: "Error reading asr probability file." };
        });

    // Run all the promises concurrently and gather the results
    const results = await Promise.allSettled([treePromise, leafPromise, ancestralPromise, nodesPromise, structPromise, inputPromise, ecPromise, asrPromise]);

    const pocketResults = await Promise.all(pocketPromises)
        .then(results => {
            const allErrors = results.every(result => result.pocketError); // Check if all results have pocketError
            if (allErrors) {
                return { pocketError: "Error reading all pocket files." };
            }
            return results.reduce((acc, result, index) => {
                acc[`pocket${index + 1}`] = result.pocket || result.pocketError;
                return acc;
            }, {});
        })
        .catch(err => {
            logger.error("Error processing pocket files: " + err);
            return { pocketError: "Error processing pocket files." };
        });

    // Collect the resolved results into one object
    const response = results.reduce((acc, result) => {
        if (result.status === 'fulfilled') {
            return { ...acc, ...result.value };
        }
        return acc;
    }, {});

    // Attach the pocket dictionary to the response
    response.pockets = pocketResults;

    // If all pockets failed, add a general pocketError
    if (pocketResults.pocketError) {
        response.pocketError = pocketResults.pocketError;
    }

    if (structPath === "") {
        response.structError = "No structure file found.";
    }

    // Send response with the files that were successfully read and any error messages
    if (response['treeError'] && response['leafError'] && response['ancestralError']
        && response['nodesError'] && response['inputError']
        && response['ecError'] && response['asrError']) {
        return res.status(500).json({ error: "Failed to read all files." });
    } else {
        return res.status(200).json(response);
    }
});

// Status endpoint
app.get("/status/:id", (req, res) => {
    const id = req.params.id;
    const filePath = `/output/EzSEA_${id}/EzSEA.log`;
    logger.info("Serving status for job: " + id);
    try {
        k8sApi.listNamespacedPod('default', undefined, undefined, undefined, undefined, `id=${id},type=run`).then((podsRes) => {
            if (podsRes.body.items.length < 1) { // Kubectl no longer tracking job or job not present, read log file for status
                fs.readFile(filePath, 'utf8', (err, data) => {
                    if (err) {
                        logger.error(`Error reading log file for job ${id}, does it exist?`);
                        return res.status(200).json({
                            error: "Job not found. Please ensure your job ID is correct.",
                            logs: ["If you just submitted your job, please allow some time for it to start processing."]
                        });
                    }
                    const logsArray = data.split('\n').filter(line => line.trim().length > 0); // Remove empty lines
                    let status = "Unknown"; // Default status

                    // Dynamically check for status based on the last line of logs
                    if (logsArray.length > 0) {
                        const lastLine = logsArray[logsArray.length - 1];
                        if (/Error|failed|Stopping/i.test(lastLine)) {
                            status = "Error"; // Check for error keywords
                        } else if (/completed|success|Done/i.test(lastLine)) {
                            status = "done"; // Check for successful completion
                        } else {
                            status = "Unknown"; // If none of the above conditions match
                        }
                    } else {
                        status = "Empty"; // No logs in the file
                    }

                    return res.status(200).json({ logs: logsArray, status: status }); // Possibly missing cases here
                });
                return;
            } else { // Job is still running and being tracked by kubectl
                const pod = podsRes.body.items[0];
                var status = pod.status.phase.trim();

                // Check container statuses for more detailed information
                if (status === "Pending") {
                    if (pod.status.containerStatuses) {
                        const containerStatus = pod.status.containerStatuses[0];
                        if (containerStatus.state.waiting && containerStatus.state.waiting.reason === "ContainerCreating") {
                            return res.status(200).json({ logs: ["Resources allocated, building compute environment"], status: "container" });
                        } else {
                            return res.status(200).json({ logs: ["Allocating resources for job, this may take a few minutes."], status: "alloc" });
                        }
                    } else {
                        return res.status(200).json({ logs: ["Allocating resources for job, this may take a few minutes."], status: "alloc" });
                    }
                } else if (status === "Failed") { // Failure case
                    fs.readFile(filePath, 'utf8', (err, data) => {
                        if (err) {
                            logger.error(`Error reading log file for job ${id}: ${err}`);
                            return res.status(500).json({ logs: "Failed to retrieve logs for the failed job.", status: status });
                        }
                        const logsArray = data.split('\n').filter(line => line.trim().length > 0); // Remove empty lines
                        return res.status(200).json({ logs: logsArray, status: status });
                    });
                } else if (status === "Succeeded") { // Note: When will the status be Unknown?
                    return res.status(200).json({ logs: "", status: "done" });
                } else {
                    fs.readFile(filePath, 'utf8', (err, data) => {
                        if (err) {
                            if (status === "Running") {
                                return res.status(200).json({ logs: ['Generating logs...'], status: "container" })
                            } else {
                                logger.error("Error reading file:", err);
                                return res.status(500).json({ error: "No log file was found for this job." });
                            }
                        }
                        const logsArray = data.split('\n').filter(line => line.trim().length > 0); // Remove empty lines
                        const lastLine = logsArray[logsArray.length - 1];

                        if (/Error|failed|Stopping/i.test(lastLine)) {
                            status = "Error"; // Check for error keywords
                        } else if (/completed|success|Done/i.test(lastLine)) {
                            status = "done"; // Check for successful completion
                        } else if (/EC/i.test(lastLine)) {
                            status = "annot"; // Check for annotation
                        } else if (/delineation/i.test(lastLine)) {
                            status = "delineation"; // If none of the above conditions match
                        } else if (/Tree/i.test(lastLine)) {
                            status = "tree";
                        } else if (/Alignment/i.test(lastLine)) {
                            status = "align";
                        } else if (/diamond/i.test(lastLine)) {
                            status = "db";
                        }
                        return res.status(200).json({ logs: logsArray, status: status });
                    });
                }
            }


        });
    } catch (err) {
        logger.error("Error getting GKE logs:", err);
        return res.status(500).json({ error: "There was a backend error. Please try again later." });
    }
});

// Server listening on PORT 5000
app.listen(5000, () => {
    logger.info('Backend is listening on port 5000');
});

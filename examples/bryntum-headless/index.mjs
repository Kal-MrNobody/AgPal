// Minimal headless recalculation with Bryntum Gantt 8 in Node: no browser, no DOM, trial mode (no licence key).
// One payment milestone gates a launch; the payment slips; the engine reschedules everything downstream.
//   npm install && npm start
import ProjectModel from '@bryntum/gantt-enterprise/lib/Gantt/model/ProjectModel.js';

const project = new ProjectModel({
  startDate: '2026-11-16',
  tasks: [
    // Bryntum's recommended model: each expected payment is its own zero-duration milestone...
    {
      id: 'pay',
      name: 'Payment received: INV-123',
      duration: 0,
      // ...whose expected date is a startnoearlierthan constraint.
      constraintType: 'startnoearlierthan',
      constraintDate: '2026-11-20',
    },
    { id: 'launch', name: 'Launch campaign', duration: 3, durationUnit: 'day' },
    { id: 'contractor', name: 'Pay contractor', duration: 1, durationUnit: 'day' },
  ],
  dependencies: [
    // It gates the milestone it unblocks with a Finish-to-Start link; settlement delay is the lag, not a padded date.
    { id: 'd1', fromTask: 'pay', toTask: 'launch', type: 2, lag: 2, lagUnit: 'day' },
    { id: 'd2', fromTask: 'launch', toTask: 'contractor', type: 2 },
  ],
});

const show = (label) => {
  console.log(`\n${label}`);
  project.taskStore.forEach((t) =>
    console.log(
      `  ${t.name.padEnd(28)} ${t.startDate.toISOString().slice(0, 10)} → ${t.endDate.toISOString().slice(0, 10)}`,
    ),
  );
};

await project.commitAsync();
show('Initial plan');

// The payment slips: change only the milestone's constraintDate and let the engine propagate.
project.taskStore.getById('pay').constraintDate = new Date('2026-11-25');
await project.commitAsync();
show('After the payment slips to 2026-11-25');

// The payment lands: mark the milestone done at the actual date.
const pay = project.taskStore.getById('pay');
pay.constraintDate = new Date('2026-11-24');
pay.percentDone = 100;
await project.commitAsync();
show('After the payment lands on 2026-11-24');

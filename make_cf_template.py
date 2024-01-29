#!/usr/bin/env python3.6

import sys
from string import Template


class CfTemplate(Template):
    delimiter = '@'


vs = dict([v.split('=') for v in sys.argv[2:] if v.islower()])
template = CfTemplate(''.join(open(sys.argv[1], 'r').readlines()))
print(template.substitute(vs))

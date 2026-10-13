"""Local agent interface to the same version/figure services used by the website."""
import argparse
import json
import sys
from pathlib import Path

from versions import ArchiveError, compare, create_snapshot, read_config, summaries
from figures import FigureStudio, figure_records


def main(area, argv):
    parser=argparse.ArgumentParser(prog='paper-hub '+area)
    actions=parser.add_subparsers(dest='action',required=True)
    if area=='versions':
        for action in ('list','save','compare'):
            command=actions.add_parser(action)
            command.add_argument('project',type=Path)
            command.add_argument('--json',action='store_true')
            if action=='save':
                command.add_argument('--name',default='')
                command.add_argument('--note',default='')
                command.add_argument('--request-id')
            elif action=='compare':
                command.add_argument('--base',required=True)
                command.add_argument('--target',default='working')
                command.add_argument('--path', help='Source file whose text diff to include; defaults to main document')
    else:
        for action in ('list','import'):
            command=actions.add_parser(action)
            command.add_argument('project',type=Path)
            command.add_argument('--json',action='store_true')
            if action=='import':
                command.add_argument('--figure',required=True)
                command.add_argument('--image',required=True,type=Path)
                command.add_argument('--instruction',default='从本地AI工具导入图片候选')
                command.add_argument('--provider',default='local-import')
                command.add_argument('--model')
                command.add_argument('--request-id')
    args=parser.parse_args(argv)
    try:
        repo=args.project.expanduser().resolve(strict=True)
        if area=='versions':
            values=summaries(repo)
            if args.action=='list':
                result={'schema_version':1,'versions':values,'latest_id':values[-1]['id'] if values else None}
            elif args.action=='save':
                result=create_snapshot(repo,args.name,args.note,values[-1]['id'] if values else None,args.request_id)
            else:
                result=compare(repo,'local',args.base,args.target,args.path)
        elif args.action=='list':
            result={'schema_version':1,'figures':figure_records(repo,read_config(repo))}
        else:
            studio=FigureStudio(lambda:[{'id':'local','repo':str(repo)}],Path(__file__).resolve().parent)
            result=studio.import_candidate('local',args.figure,args.image.expanduser().resolve(strict=True),args.instruction,args.provider,args.model,args.request_id)
        print(json.dumps(result,ensure_ascii=False,indent=None if args.json else 2))
        return 0
    except (ArchiveError,OSError,ValueError,KeyError,TypeError) as error:
        print('paper-hub '+area+': '+str(error),file=sys.stderr)
        return 1
